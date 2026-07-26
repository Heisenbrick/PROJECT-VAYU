/**
 * AFIP :: Evidence Adapter
 * ---------------------------------------------------------------------
 * Purpose
 *   Convert raw simulator telemetry into timestamped Evidence Records
 *   before anything enters the World State. This is the ONLY module
 *   that reads simulator variables directly — every other AFIP module
 *   reads Evidence Records or the World State, never the simulator.
 *
 * Inputs
 *   - A raw telemetry object handed in once per simulator frame, by a
 *     single additive call the simulator's own loop() makes. See
 *     Simulator_AFIP.html, inside loop(), for the call site.
 *
 * Outputs
 *   - Evidence Records (AFIP.EvidenceRecordShape), pushed to
 *     AFIP.WorldStateEngine via AFIP.bus.emit('evidence:batch', ...).
 *
 * Dependencies
 *   - None (root of the AFIP pipeline; reads simulator directly).
 *
 * Status
 *   IMPLEMENTED (Roadmap Phase 2 — Evidence Integration).
 *
 * Coverage note — read before extending
 *   The attached simulator (Simulator_AFIP.html) is a deterministic,
 *   parametric transition-physics visualizer: it computes phase, tilt,
 *   velocity, altitude, and gyroscopic spar-shear torque from mission
 *   time. It does NOT produce battery, GPS, motor/ESC temperature,
 *   IMU, wind, ambient temperature, or communication-link data — those
 *   rows in the Integration Spec §4.3 Mapping Matrix have no source in
 *   this build. FIELD_MAP below lists only what is genuinely available.
 *   AWAITING_SOURCE lists what is not, so Health/Risk/Prediction
 *   modules (Phase 4) know exactly what they can and cannot reason
 *   about. Do not backfill AWAITING_SOURCE fields with synthetic or
 *   randomized values — AFIP does not fake intelligence.
 * ---------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var AFIP = global.AFIP = global.AFIP || {};

  /**
   * Simulator field -> Evidence field mapping. `extract` reads the raw
   * telemetry object passed to ingest() for one frame.
   * World-state namespacing follows Integration Spec §4.3/§5.
   */
  var FIELD_MAP = [
    { field: 'Mission.Clock',            extract: function (r) { return r.t; } },
    { field: 'Mission.Progress.Phase',   extract: function (r) { return r.phaseName; } },
    { field: 'Mission.Progress.PhaseIndex', extract: function (r) { return r.phase; } },
    { field: 'Mission.Progress.PhaseFraction', extract: function (r) { return r.localX; } },
    { field: 'Mission.Status.Playing',   extract: function (r) { return r.playing; } },
    { field: 'Mission.Status.SpeedMultiplier', extract: function (r) { return r.speed; } },

    { field: 'Aircraft.Kinematics.Airspeed',   extract: function (r) { return r.vel; } },   // km/h
    { field: 'Aircraft.Kinematics.GroundSpeed',extract: function (r) { return r.vel; } },   // no separate wind model yet — see AWAITING_SOURCE
    { field: 'Aircraft.Altitude',              extract: function (r) { return r.alt; } },   // m
    { field: 'Aircraft.Configuration.RotorTiltAngle', extract: function (r) { return r.tilt; } }, // deg
    { field: 'Aircraft.Configuration.TransitionMode',
      extract: function (r) { return r.phase === 2 || r.phase === 4; } },
    { field: 'Aircraft.Payload.Mass',          extract: function (r) { return r.payload; } }, // kg

    { field: 'Navigation.Progress.DistanceTraveled', extract: function (r) { return r.distanceTraveled; } },
    { field: 'Navigation.Progress.TotalDistance',    extract: function (r) { return r.totalDist; } },
    { field: 'Navigation.Progress.DistanceRemaining',
      extract: function (r) { return Math.max(0, r.totalDist - r.distanceTraveled); } },

    { field: 'Mission.Constraints.CruiseSpeedSetting', extract: function (r) { return r.cruiseSpeedSetting; } },
    { field: 'Mission.Constraints.CruiseAltitudeSetting', extract: function (r) { return r.cruiseAltSetting; } },

    // Not in the original mapping matrix, but genuinely computed by the
    // simulator and safety-relevant — the sim's own UI already treats
    // this as a structural health signal (spar shear warning). Filed
    // under Aircraft, not Health: per Integration Spec §5.6, the Health
    // object is produced exclusively by the Health Monitor module
    // (Phase 4), which will read this raw evidence to derive
    // Health.PropulsionHealth / WarningFlags, not the other way around.
    { field: 'Aircraft.Structural.GyroscopicTorque',    extract: function (r) { return r.tauGyro; } }, // N·m
    { field: 'Aircraft.Structural.TorqueClockwise',     extract: function (r) { return r.tauCW; } },
    { field: 'Aircraft.Structural.TorqueCounterClockwise', extract: function (r) { return r.tauCCW; } },

    // ---------------------------------------------------------------
    // Dashboard integration (flight-intelligence-dashboard) additions.
    // This build's "simulator" is the dashboard's own telemetry
    // generator (app.js `state` + Leaflet waypoint transit), which is
    // the same role Simulator_AFIP.html's physics loop played for the
    // original FIELD_MAP above: a raw source AFIP reads but never
    // computes itself. Unlike the bare transition-physics simulator,
    // this dashboard's generator genuinely produces battery, GPS,
    // wind/ambient, and comms-link readings every tick, so the rows
    // below close real AWAITING_SOURCE gaps rather than fabricating
    // them — see health-monitor.js's own comment ("this module will
    // pick the signal up automatically the moment ... fields carry
    // real evidence") for why no downstream module needed to change
    // for most of these.
    // ---------------------------------------------------------------
    { field: 'Aircraft.Position.Latitude',  extract: function (r) { return r.lat; } },
    { field: 'Aircraft.Position.Longitude', extract: function (r) { return r.lng; } },
    { field: 'Aircraft.Attitude.Roll',  extract: function (r) { return r.roll; } },
    { field: 'Aircraft.Attitude.Pitch', extract: function (r) { return r.pitch; } },
    { field: 'Aircraft.Attitude.Yaw',   extract: function (r) { return r.yaw; } },
    { field: 'Aircraft.Heading',        extract: function (r) { return r.yaw; } },
    { field: 'Aircraft.Kinematics.VerticalSpeed', extract: function (r) { return r.vspeed; } },

    { field: 'Navigation.Sensor.GPSPosition', extract: function (r) { return { lat: r.lat, lng: r.lng }; } },
    { field: 'Navigation.Sensor.GPSQuality',  extract: function (r) { return r.gpsQuality; } },

    { field: 'Energy.State.BatteryPercentage', extract: function (r) { return r.batteryPct; } },
    { field: 'Energy.Telemetry.BatteryCurrent', extract: function (r) { return r.batteryCurrentA; } },
    // Pack nominal voltage: a configuration constant reported by the
    // dashboard's BMS readout, not a per-cycle sensor sample — same
    // category as Mission.Constraints.CruiseSpeedSetting above.
    { field: 'Energy.Telemetry.BatteryVoltage', extract: function (r) { return r.batteryVoltageNominal; } },
    { field: 'Energy.ConsumptionRate', extract: function (r) { return consumptionRateMeter(r); } },

    { field: 'Communication.LinkStatus',   extract: function (r) { return r.commsLinkStatus; } },
    { field: 'Communication.Latency',      extract: function (r) { return r.commsLatencyMs; } },
    { field: 'Communication.SignalQuality',extract: function (r) { return r.commsSignalQuality; } },

    { field: 'Environment.Weather.WindSpeed',        extract: function (r) { return r.windSpeedKts; } },
    { field: 'Environment.Weather.WindDirection',     extract: function (r) { return r.windDirDeg; } },
    { field: 'Environment.Weather.AmbientTemperature',extract: function (r) { return r.ambientTempC; } },

    // Real (if simplified) propulsion signal this airframe has instead
    // of the tiltrotor's gyroscopic-shear proxy: per-motor RPM% and
    // fault status from the dashboard's 8-motor BMS/ESC readout.
    { field: 'Aircraft.Propulsion.MotorRPMAverage', extract: function (r) { return r.motorRPMAverage; } },
    { field: 'Aircraft.Propulsion.MotorFaultCount', extract: function (r) { return r.motorFaultCount; } }
  ];

  /**
   * Energy.ConsumptionRate (%/second) is not a raw sensor field on this
   * (or any real) airframe — it is a rate meter derived from repeated
   * Energy.State.BatteryPercentage samples over the mission clock, the
   * same "observe the sensor over time" role HealthMonitor's own
   * gyroscopic-shear trend window plays. Computed here (once, next to
   * the field it depends on) rather than duplicated inside every
   * downstream consumer.
   */
  var _rateHistory = [];
  var RATE_WINDOW_SAMPLES = 20;
  function consumptionRateMeter(r) {
    if (typeof r.batteryPct !== 'number' || typeof r.t !== 'number') return null;
    _rateHistory.push({ t: r.t, v: r.batteryPct });
    while (_rateHistory.length > RATE_WINDOW_SAMPLES) _rateHistory.shift();
    if (_rateHistory.length < 5) return null;
    var n = _rateHistory.length, sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += _rateHistory[i].t; sumY += _rateHistory[i].v;
      sumXY += _rateHistory[i].t * _rateHistory[i].v; sumXX += _rateHistory[i].t * _rateHistory[i].t;
    }
    var denom = (n * sumXX - sumX * sumX);
    if (Math.abs(denom) < 1e-9) return null;
    var slope = (n * sumXY - sumX * sumY) / denom; // %/second, negative while discharging
    return slope < 0 ? -slope : 0; // ConsumptionRate is reported as a positive %/s magnitude
  }

  /**
   * World State fields the Mapping Matrix (§4.3) calls for that this
   * simulator build does not produce. Documentation only — no Evidence
   * Records are emitted for these. Populate FIELD_MAP above, not this
   * list, once a real source exists (PX4/ArduPilot/ROS2/real sensors).
   */
  AFIP.AWAITING_SOURCE = Object.freeze([
    // Closed by the dashboard integration (see FIELD_MAP additions
    // above): Aircraft.Position.*, Navigation.Sensor.GPS*,
    // Energy.State.BatteryPercentage, Energy.Telemetry.Battery*,
    // Energy.ConsumptionRate, Communication.*, Environment.Weather.*.
    // Still genuinely absent — no per-motor winding-temperature, true
    // RPM (rad/s), or IMU sensor exists in either the physics simulator
    // or the dashboard's telemetry model. The dashboard does provide an
    // 8-motor RPM%/fault-count *average* (Aircraft.Propulsion.*, a real
    // but coarser proxy health-monitor.js's assessPropulsion() now uses)
    // — it is not the same signal as the rows below:
    'Energy.Remaining.EstimatedEnergy',
    'Health.Propulsion.MotorTemperature', 'Health.Propulsion.MotorRPM',
    'Health.Powertrain.ESCTemperature', 'Health.SensorIntegrity.IMUStatus'
  ]);

  var frameCounter = 0;
  var lastBatch = [];

  function EvidenceAdapter() {}

  /**
   * Called once per simulator frame with the raw telemetry object.
   * Produces Evidence Records and hands them to the World State Engine
   * via the bus — this function never mutates World State directly.
   * @param {object} raw - see Simulator_AFIP.html loop() call site.
   * @returns {object[]} Evidence Records emitted this frame.
   */
  EvidenceAdapter.prototype.ingest = function (raw) {
    if (!raw) return [];
    var timestamp = (typeof raw.t === 'number') ? raw.t : 0;
    var frame = frameCounter++;

    var batch = FIELD_MAP.map(function (m) {
      return {
        source: 'simulator.telemetry',
        field: m.field,
        value: m.extract(raw),
        timestamp: timestamp,
        frame: frame
      };
    });

    lastBatch = batch;
    AFIP.bus.emit('evidence:batch', batch);
    return batch;
  };

  /** @returns {object[]} the most recent batch of Evidence Records. */
  EvidenceAdapter.prototype.latest = function () {
    return lastBatch;
  };

  AFIP.EvidenceAdapter = AFIP.EvidenceAdapter || new EvidenceAdapter();
})(typeof window !== 'undefined' ? window : globalThis);
