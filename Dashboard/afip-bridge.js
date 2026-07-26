/**
 * afip-bridge.js
 * ---------------------------------------------------------------------
 * Integration glue between the flight-intelligence-dashboard (app.js's
 * telemetry-generating `state` object + Leaflet waypoint transit) and
 * the AFIP reasoning stack (/afip/*.js, phases 1-12).
 *
 * Responsibilities (and nothing else — no reasoning lives here):
 *   1. Each dashboard simulation tick, translate `state` into the same
 *      raw-telemetry shape Simulator_AFIP.html's loop() hands to
 *      AFIP.EvidenceAdapter.ingest(), then run the exact same
 *      pipeline order documented in /afip/README.md.
 *   2. Mount the ten Phase-11 AFIP UI panels into the dashboard's new
 *      "AFIP Operator Control Station" section.
 *   3. Feed real AFIP outputs into the dashboard's pre-existing legacy
 *      readouts (AI confidence badge, explainability text, the four
 *      module-status chips, the decision-history log) so those panels
 *      stop showing scripted/random values and start showing this
 *      cycle's actual Decision Engine / Explainability output.
 *
 * AFIP itself never controls the aircraft here either — this bridge
 * only reads `state` and writes back state.aiConfidence/explainText,
 * exactly the two fields app.js's own updateUIElements() already
 * displays every tick; it never touches motors, position, or physics.
 * ---------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var AFIP = global.AFIP;
  if (!AFIP) { return; } // afip-core.js didn't load — nothing to bridge.

  // Mission-context constants standing in for settings this dashboard
  // doesn't expose as live telemetry (matches the static values already
  // shown in the HTML/CSS mock, so nothing here contradicts the UI).
  var PAYLOAD_MASS_KG = 1200;          // matches "CARGO BAY" panel's 1,200 kg
  var BATTERY_VOLTAGE_NOMINAL = 82.4;  // matches "POWER MATRIX" panel's 82.4V tag
  var CRUISE_SPEED_KMH = 48.2 * 1.852; // dashboard's baseline cruise speed (kts -> km/h)
  var CRUISE_ALT_M = 328 * 0.3048;     // dashboard's baseline cruise altitude (ft -> m)

  // --- Route geometry (real, from the actual Leaflet waypoints) --------
  var _routeTotal = null;
  var _legDistances = [];

  function haversineMeters(a, b) {
    var R = 6371000;
    function toRad(d) { return d * Math.PI / 180; }
    var dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    var la1 = toRad(a[0]), la2 = toRad(b[0]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function ensureRoute() {
    if (_routeTotal !== null) return;
    var wps = (global.TacticalMap && global.TacticalMap.waypoints) || [];
    var total = 0;
    _legDistances = [];
    for (var i = 1; i < wps.length; i++) {
      var d = haversineMeters(wps[i - 1].coords, wps[i].coords);
      _legDistances.push(d);
      total += d;
    }
    _routeTotal = total;
  }

  function distanceTraveled(state) {
    ensureRoute();
    var idx = Math.min(state.currentWaypointIndex, _legDistances.length);
    var traveled = 0;
    for (var i = 0; i < idx; i++) traveled += _legDistances[i];
    if (idx < _legDistances.length) traveled += _legDistances[idx] * (state.waypointProgress || 0);
    return traveled;
  }

  // --- Raw telemetry translation ----------------------------------------
  function phaseFor(state) {
    if (state.systemMode === 'LANDING' || state.systemMode === 'LANDED') return { index: 5, name: 'LANDING' };
    if (state.systemMode === 'CRASHING' || state.systemMode === 'CRASHED') return { index: 5, name: 'DESCENT_UNCONTROLLED' };
    return { index: 3, name: 'CRUISE' };
  }

  function buildRaw(state, currentCoords) {
    ensureRoute();
    var phase = phaseFor(state);
    var latencyMatch = /(\d+(\.\d+)?)/.exec(state.commsStatus || '');
    var motorRPMAverage = state.motorRPMs.reduce(function (a, b) { return a + b; }, 0) / state.motorRPMs.length;
    var motorFaultCount = state.motorStatus.filter(function (s) { return s < 1.0; }).length;

    return {
      t: (Date.now() - state.startTime) / 1000,
      phaseName: phase.name, phase: phase.index, localX: state.waypointProgress,
      playing: !(state.systemMode === 'LANDED' || state.systemMode === 'CRASHED'),
      speed: 1,
      vel: state.speedKnots * 1.852,   // kts -> km/h, matches original FIELD_MAP's unit
      alt: state.altitudeAgl * 0.3048, // ft -> m
      tilt: 0,                         // no tiltrotor transition modeled on this airframe
      payload: PAYLOAD_MASS_KG,
      distanceTraveled: distanceTraveled(state),
      totalDist: _routeTotal,
      cruiseSpeedSetting: CRUISE_SPEED_KMH,
      cruiseAltSetting: CRUISE_ALT_M,
      // tauGyro/tauCW/tauCCW intentionally omitted (undefined): this
      // airframe has no gyroscopic-shear sensor — see
      // Aircraft.Propulsion.* below for its real propulsion signal.
      lat: currentCoords[0], lng: currentCoords[1],
      roll: state.attitude.roll, pitch: state.attitude.pitch, yaw: state.attitude.yaw,
      vspeed: state.verticalSpeed,
      gpsQuality: state.gpsStatus,
      batteryPct: state.batteryPct,
      batteryCurrentA: state.powerDraw,
      batteryVoltageNominal: BATTERY_VOLTAGE_NOMINAL,
      commsLinkStatus: /SAT-LINK/i.test(state.commsStatus || '') ? 'CONNECTED' : 'DEGRADED',
      commsLatencyMs: latencyMatch ? parseFloat(latencyMatch[1]) : null,
      commsSignalQuality: 'NOMINAL',
      windSpeedKts: state.windSpeed,
      windDirDeg: state.windDir,
      ambientTempC: state.tempC,
      motorRPMAverage: motorRPMAverage,
      motorFaultCount: motorFaultCount
    };
  }

  // --- Panel mounting (Phase 11 panels, same pattern as Simulator_AFIP.html) --
  var panels = null;
  function mountPanels() {
    if (!AFIP.UI || panels) return;
    var el = function (id) { return document.getElementById(id); };
    if (!el('afip-panel-health')) return; // section not in the DOM yet
    panels = {
      health: new AFIP.UI.HealthPanel(el('afip-panel-health')),
      prediction: new AFIP.UI.PredictionPanel(el('afip-panel-prediction')),
      risk: new AFIP.UI.RiskPanel(el('afip-panel-risk')),
      missionPlanner: new AFIP.UI.MissionPlannerPanel(el('afip-panel-mission-planner')),
      navigation: new AFIP.UI.NavigationPanel(el('afip-panel-navigation')),
      missionExecutive: new AFIP.UI.MissionPanel(el('afip-panel-mission-executive')),
      decision: new AFIP.UI.DecisionConsole(el('afip-panel-decision')),
      explainability: new AFIP.UI.ExplainabilityPanel(el('afip-panel-explainability')),
      operator: new AFIP.UI.OperatorConsole(el('afip-panel-operator')),
      timeline: new AFIP.UI.TimelinePanel(el('afip-panel-timeline'))
    };
  }

  // --- Legacy-panel bindings (existing DOM the mock dashboard shipped with) --
  function severityClass(v) {
    var s = String(v || '').toUpperCase();
    if (s === 'CRITICAL' || s === 'SUSPENDED' || s === 'REJECTED' || s === 'NOT_READY') return 'red';
    if (s === 'WARNING' || s === 'DEGRADED' || s === 'MINIMAL' || s === 'MODIFIED' || s === 'CAUTION' || s === 'CAUTIOUS') return 'amber';
    return 'green';
  }

  function setModuleStatus(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'module-status-item ' + severityClass(value);
    var statusSpan = el.querySelector('.status');
    if (statusSpan) statusSpan.textContent = value ? String(value).toUpperCase() : 'N/A';
  }

  var _lastLoggedDecisionKey = null;
  function logDecisionRow(decision, explanation) {
    var tbody = document.getElementById('decision-history-rows');
    if (!tbody) return;
    var timeStr = new Date().toISOString().slice(11, 16);
    var badgeClass = 'badge-success';
    if (decision.result === 'modified') badgeClass = 'badge-warning';
    else if (decision.result === 'rejected') badgeClass = 'badge-danger';
    var reasonText = (explanation && explanation.reason && explanation.reason[0]) || decision.acceptedProposal;

    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + timeStr + '</td>' +
      '<td class="code">' + decision.acceptedProposal + '</td>' +
      '<td>' + reasonText + '</td>' +
      '<td><span class="badge ' + badgeClass + '">' + decision.result.toUpperCase() + '</span></td>';
    tbody.insertBefore(row, tbody.firstChild);
    while (tbody.children.length > 40) tbody.removeChild(tbody.lastChild);
  }

  function applyLegacyBindings(state, health, risk, missionExec, decision) {
    if (decision && typeof decision.confidence === 'number') {
      state.aiConfidence = Math.round(decision.confidence * 1000) / 10; // 0..1 -> 0..100
    }

    var expl = AFIP.ExplainabilityEngine && AFIP.ExplainabilityEngine.getLatest();
    if (expl && expl.explanation) {
      var reason = (expl.explanation.reason || []).join(' ');
      state.explainText = reason ? (expl.explanation.decision + ' ' + reason) : expl.explanation.decision;
    }

    setModuleStatus('mod-fusion', health && health.overallClassification);
    setModuleStatus('mod-nav', risk && risk.overallRisk && risk.overallRisk.tier);
    setModuleStatus('mod-control', missionExec && missionExec.executivePosture);
    setModuleStatus('mod-perception', decision && decision.result);

    if (decision) {
      var key = decision.acceptedProposal + ':' + decision.result;
      if (key !== _lastLoggedDecisionKey) {
        _lastLoggedDecisionKey = key;
        logDecisionRow(decision, expl && expl.explanation);
      }
    }
  }

  // --- Main per-tick pipeline (mirrors Simulator_AFIP.html's loop()) ------
  function tick(state, currentCoords) {
    if (!AFIP.EvidenceAdapter || !AFIP.WorldStateEngine) return;
    mountPanels();

    var raw = buildRaw(state, currentCoords);
    AFIP.EvidenceAdapter.ingest(raw);
    var snapshot = AFIP.WorldStateEngine.publish();

    var health = null, prediction = null, risk = null, navigation = null, missionExec = null, decision = null;

    if (AFIP.HealthMonitor) { health = AFIP.HealthMonitor.update(snapshot); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.PredictionEngine) { prediction = AFIP.PredictionEngine.update(snapshot, health); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.RiskEngine) { risk = AFIP.RiskEngine.update(snapshot, health, prediction); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.OperatorCommands) { AFIP.OperatorCommands.update(snapshot); }
    if (AFIP.MissionPlanner) { AFIP.MissionPlanner.update(snapshot); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.NavigationIntelligence) { navigation = AFIP.NavigationIntelligence.update(snapshot, prediction); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.MissionExecutive) { missionExec = AFIP.MissionExecutive.update(snapshot, health, prediction); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.DecisionEngine) { decision = AFIP.DecisionEngine.update(snapshot, missionExec, risk); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.ExplainabilityEngine) { AFIP.ExplainabilityEngine.update(snapshot, missionExec, decision); snapshot = AFIP.WorldStateEngine.publish(); }
    if (AFIP.MissionTimeline) { AFIP.MissionTimeline.update(snapshot, decision, navigation); snapshot = AFIP.WorldStateEngine.publish(); }

    if (panels) {
      panels.health.render(AFIP.HealthMonitor && AFIP.HealthMonitor.getLatest());
      panels.prediction.render(AFIP.PredictionEngine && AFIP.PredictionEngine.getLatest());
      panels.risk.render(AFIP.RiskEngine && AFIP.RiskEngine.getLatest());
      panels.missionPlanner.render(AFIP.MissionPlanner && AFIP.MissionPlanner.getLatest());
      panels.navigation.render(AFIP.NavigationIntelligence && AFIP.NavigationIntelligence.getLatest());
      panels.missionExecutive.render(AFIP.MissionExecutive && AFIP.MissionExecutive.getLatest());
      panels.decision.render(AFIP.DecisionEngine && AFIP.DecisionEngine.getLatest());
      panels.explainability.render(AFIP.ExplainabilityEngine && AFIP.ExplainabilityEngine.getLatest());
      panels.operator.render(AFIP.OperatorCommands && AFIP.OperatorCommands.getLatest());
    }

    applyLegacyBindings(state, health, risk, missionExec, decision);
  }

  function submitOperatorCommand(name) {
    if (AFIP.OperatorCommands) AFIP.OperatorCommands.submit(name);
  }

  global.AFIPBridge = { tick: tick, submitOperatorCommand: submitOperatorCommand, mountPanels: mountPanels };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanels);
  } else {
    mountPanels();
  }
})(typeof window !== 'undefined' ? window : globalThis);
