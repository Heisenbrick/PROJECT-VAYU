// --------------------------------------------------------
// GLOBAL STATE & UI ELEMENTS
// --------------------------------------------------------
const state = {
  t: 0,
  playing: false,
  dragging: false,
  speed: 1.0,
  battery: 100
};

const els = {
  transdur: document.getElementById('param-transdur'),
  payload: document.getElementById('param-payload'),
  cruisespeed: document.getElementById('param-cruisespeed'),
  cruisealt: document.getElementById('param-cruisealt'),
  playBtn: document.getElementById('play-btn'),
  resetBtn: document.getElementById('reset-btn'),
  chart: document.getElementById('telemetry-chart')
};

// --------------------------------------------------------
// PHYSICS MATH & DURATIONS (Restored from original)
// --------------------------------------------------------
function easeOut(t) { return t * (2 - t); }
function easeInOutCos(t) { return 0.5 * (1 - Math.cos(Math.PI * t)); }

function getDurations() {
  const spool = 2, climb = 3, cruiseTail = 30; // Fly for a long time!
  const trans = parseFloat(els.transdur.value) || 6;
  const descTrans = trans, descend = climb;
  return { 
    spool, climb, trans, cruiseTail, descTrans, descend, 
    total: spool + climb + trans + cruiseTail + descTrans + descend 
  };
}

function computeState(t) {
  const { spool, climb, trans, cruiseTail, descTrans, descend, total } = getDurations();
  const payload = parseFloat(els.payload.value) || 80;
  const cruiseSpeed = parseFloat(els.cruisespeed.value) || 120;
  const ALT_CRUISE = parseFloat(els.cruisealt.value) || 150;
  const VEL_CLIMB_END = 8;

  let phase, localX;
  let tilt = 0, vel = 0, alt = 0, tiltRateDegPerSec = 0;

  const t1 = spool;
  const t2 = spool + climb;
  const t3 = spool + climb + trans;
  const t4 = t3 + cruiseTail;
  const t5 = t4 + descTrans;

  if (t < t1) {
    phase = 0; localX = t / spool;
    tilt = 90; vel = 0; alt = 0;
  } else if (t < t2) {
    phase = 1; localX = (t - t1) / climb;
    tilt = 90;
    vel = VEL_CLIMB_END * easeOut(localX);
    alt = ALT_CRUISE * easeOut(localX);
  } else if (t < t3) {
    phase = 2; localX = (t - t2) / trans;
    const e = easeInOutCos(localX);
    tilt = 90 * (1 - e);
    vel = VEL_CLIMB_END + (cruiseSpeed - VEL_CLIMB_END) * e;
    alt = ALT_CRUISE;
    const ep = 0.5 * Math.PI * Math.sin(Math.PI * localX);
    tiltRateDegPerSec = -90 * ep / trans;
  } else if (t < t4) {
    phase = 3; localX = (t - t3) / cruiseTail;
    tilt = 0; vel = cruiseSpeed; alt = ALT_CRUISE;
  } else if (t < t5) {
    phase = 4; localX = (t - t4) / descTrans;
    const e = easeInOutCos(localX);
    tilt = 90 * e;
    vel = cruiseSpeed - (cruiseSpeed - VEL_CLIMB_END) * e;
    alt = ALT_CRUISE;
    const ep = 0.5 * Math.PI * Math.sin(Math.PI * localX);
    tiltRateDegPerSec = 90 * ep / descTrans;
  } else {
    phase = 5; localX = Math.min(1, (t - t5) / Math.max(0.0001, descend));
    tilt = 90;
    const de = easeOut(localX);
    vel = VEL_CLIMB_END * (1 - de);
    alt = ALT_CRUISE * (1 - de);
  }

  const omegaTiltRad = Math.abs(tiltRateDegPerSec) * Math.PI / 180;
  const K = 60 + payload * 0.15;
  const tauGyro = K * omegaTiltRad;

  // Power draw approximation based on hover vs cruise
  const powerDraw = (tilt === 0) ? 0.5 : 2.0;

  return { phase, localX, tilt, vel, alt, tauGyro, powerDraw };
}

// Global cached distance mapping to position correctly over time
let posCurve = [];
function regenerateWorld() {
  posCurve = [];
  let totalDist = 0;
  const { total } = getDurations();
  const POS_STEPS = 500;
  const dt = total / POS_STEPS;
  posCurve.push({ t: 0, z: 0 });
  for (let i = 1; i <= POS_STEPS; i++) {
    const s = computeState(i * dt);
    const v_m_s = s.vel * 1000 / 3600; // km/h to m/s
    totalDist += v_m_s * dt;
    posCurve.push({ t: i * dt, z: totalDist });
  }
}

function getZForTime(t) {
  const { total } = getDurations();
  const frac = Math.max(0, Math.min(1, t / total));
  const idx = Math.floor(frac * 500);
  if (idx >= 500) return posCurve[posCurve.length - 1].z;
  const p0 = posCurve[idx];
  const p1 = posCurve[Math.min(idx + 1, posCurve.length - 1)];
  const localFrac = (t - p0.t) / (p1.t - p0.t || 1);
  return p0.z + (p1.z - p0.z) * localFrac;
}

// --------------------------------------------------------
// FLIGHT PATH (City traversal)
// --------------------------------------------------------
const flightPath = new THREE.CurvePath();

// City grid: gridSize=60, streets at every 4th cell → world coords 0, ±240, ±480...
// Drone corridor clears |x|<=1 → world X = -60 to +60
// So actual street centers: X = 0, ±240, ±480... and Z = 0, ±240, ±480...

// Segment 1: Fly north along X=0 (the main drone corridor)
flightPath.add(new THREE.LineCurve3(
  new THREE.Vector3(0, 0, 1500),
  new THREE.Vector3(0, 0, 30)
));

// Turn right onto Z=0 street (east-west)
flightPath.add(new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(0, 0, 30),
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(30, 0, 0)
));

// Segment 2: Fly east along Z=0 to X=240 street
flightPath.add(new THREE.LineCurve3(
  new THREE.Vector3(30, 0, 0),
  new THREE.Vector3(210, 0, 0)
));

// Turn left onto X=240 street (north-south)
flightPath.add(new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(210, 0, 0),
  new THREE.Vector3(240, 0, 0),
  new THREE.Vector3(240, 0, -30)
));

// Segment 3: Fly north along X=240
flightPath.add(new THREE.LineCurve3(
  new THREE.Vector3(240, 0, -30),
  new THREE.Vector3(240, 0, -210)
));

// Turn left onto Z=-240 street (east-west, going west)
flightPath.add(new THREE.QuadraticBezierCurve3(
  new THREE.Vector3(240, 0, -210),
  new THREE.Vector3(240, 0, -240),
  new THREE.Vector3(210, 0, -240)
));

// Segment 4: Fly west along Z=-240, all the way out of the city
flightPath.add(new THREE.LineCurve3(
  new THREE.Vector3(210, 0, -240),
  new THREE.Vector3(-1500, 0, -240)
));

function getPathData(t) {
  const { total } = getDurations();
  const dist = getZForTime(t);
  const maxDist = getZForTime(total);
  const frac = maxDist > 0 ? Math.max(0, Math.min(1, dist / maxDist)) : 0;
  
  const pt = flightPath.getPointAt(frac);
  const tangent = flightPath.getTangentAt(frac).normalize();
  return { pt, tangent };
}

// --------------------------------------------------------
// THREE.JS SETUP
// --------------------------------------------------------
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();

// --------------------------------------------------------
// BEAUTIFUL STABLE WEATHER BACKGROUND (Sky Gradient)
// --------------------------------------------------------
const skyCanvas = document.createElement('canvas');
skyCanvas.width = 2;
skyCanvas.height = 512;
const skyCtx = skyCanvas.getContext('2d');
const skyGradient = skyCtx.createLinearGradient(0, 0, 0, 512);
skyGradient.addColorStop(0, '#1e4877'); // Deep clear sky at zenith
skyGradient.addColorStop(0.6, '#4584b4'); // Mid sky
skyGradient.addColorStop(1, '#ffdfb0'); // Warm horizon
skyCtx.fillStyle = skyGradient;
skyCtx.fillRect(0, 0, 2, 512);

const skyTexture = new THREE.CanvasTexture(skyCanvas);
skyTexture.colorSpace = THREE.SRGBColorSpace; // if available, or just ignore for r128
scene.background = skyTexture;
// Fog matches the warm horizon color for a seamless fade
scene.fog = new THREE.FogExp2(0xffdfb0, 0.0004);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 3000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Realistic Lighting (Sunny afternoon)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xfff0dd, 1.4); // Warm, bright sunlight
dirLight.position.set(400, 300, -200); // Lower angle sun
dirLight.castShadow = true;
dirLight.shadow.camera.top = 400; dirLight.shadow.camera.bottom = -400;
dirLight.shadow.camera.left = -400; dirLight.shadow.camera.right = 400;
dirLight.shadow.camera.near = 0.1; dirLight.shadow.camera.far = 2000;
dirLight.shadow.mapSize.width = 2048; dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// --------------------------------------------------------
// PROCEDURAL CITY GENERATION
// --------------------------------------------------------
const cityGroup = new THREE.Group();
scene.add(cityGroup);

const groundGeo = new THREE.PlaneGeometry(10000, 10000);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x4a8c3f, roughness: 0.95, metalness: 0.0 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
cityGroup.add(ground);

// Grid removed - using proper asphalt roads instead

// Window texture generator — builds a distinct facade texture (wall color + window
// grid) for each building style, so buildings read as different colored buildings
// rather than the same gray tower repeated everywhere.
function makeFacadeTexture(wallColor, glassColor, litColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = wallColor;
  ctx.fillRect(0, 0, 128, 256);

  const winW = 16, winH = 16, stepX = 30, stepY = 30, marginX = 7, marginY = 9;
  for (let x = marginX; x < 128 - winW; x += stepX) {
    for (let y = marginY; y < 256 - winH; y += stepY) {
      if (Math.random() > 0.92) continue; // occasional missing window (recess/balcony)
      const lit = Math.random() < 0.16;
      ctx.fillStyle = lit ? litColor : glassColor;
      ctx.fillRect(x, y, winW, winH);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

// A palette of building styles — each is its own wall color + glass tone + material finish.
const buildingStyles = [
  { wall: '#c1543f', glass: '#241512', lit: '#ffe1a0', metalness: 0.1, roughness: 0.85 }, // red brick
  { wall: '#d8bf8e', glass: '#33445a', lit: '#ffe9a8', metalness: 0.1, roughness: 0.8 },  // tan / sandstone
  { wall: '#7c94ad', glass: '#141d26', lit: '#fff0c0', metalness: 0.75, roughness: 0.2 }, // blue glass tower
  { wall: '#5b6b76', glass: '#0c1216', lit: '#ffedb0', metalness: 0.7, roughness: 0.25 }, // steel & glass
  { wall: '#8a5fa0', glass: '#221a30', lit: '#ffe0a0', metalness: 0.15, roughness: 0.7 }, // purple accent tower
  { wall: '#4c8067', glass: '#101f18', lit: '#ffe8a8', metalness: 0.2, roughness: 0.7 },  // green-tinted facade
  { wall: '#e8e4da', glass: '#22262b', lit: '#ffedb0', metalness: 0.3, roughness: 0.5 },  // cream office block
  { wall: '#232730', glass: '#040608', lit: '#ffdd88', metalness: 0.85, roughness: 0.15 }, // black glass skyscraper
  { wall: '#c98a3f', glass: '#2a1d10', lit: '#ffe6b0', metalness: 0.1, roughness: 0.8 },  // amber / ochre concrete
  { wall: '#9aa5ad', glass: '#1b2226', lit: '#fff2c8', metalness: 0.5, roughness: 0.4 },  // pale concrete + glass
];

// Materials
const buildingMats = buildingStyles.map(st => new THREE.MeshStandardMaterial({
  map: makeFacadeTexture(st.wall, st.glass, st.lit),
  roughness: st.roughness,
  metalness: st.metalness
}));

// Roof (top/bottom face) — dark rooftop with black windows/vents, seen when looking down from the drone.
const roofMat = new THREE.MeshStandardMaterial({
  map: makeFacadeTexture('#1a1a1a', '#000000', '#000000'),
  roughness: 0.9,
  metalness: 0.15
});

const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
const buildings = [];

const gridSize = 60;
const blocks = 40; 

// Generate Asphalt Roads
const roadGeo = new THREE.PlaneGeometry(10000, 30); // 30 units wide road
const roadMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
const lineGeo = new THREE.PlaneGeometry(10000, 0.5);
const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

for (let i = -blocks; i <= blocks; i += 4) {
  // Z-Streets (East-West)
  const zRoad = new THREE.Mesh(roadGeo, roadMat);
  zRoad.rotation.x = -Math.PI / 2;
  zRoad.position.set(0, 0.05, i * gridSize);
  zRoad.receiveShadow = true;
  cityGroup.add(zRoad);
  const zLine = new THREE.Mesh(lineGeo, lineMat);
  zLine.rotation.x = -Math.PI / 2;
  zLine.position.set(0, 0.06, i * gridSize);
  cityGroup.add(zLine);
  
  // X-Streets (North-South)
  const xRoad = new THREE.Mesh(roadGeo, roadMat);
  xRoad.rotation.x = -Math.PI / 2;
  xRoad.rotation.z = Math.PI / 2;
  xRoad.position.set(i * gridSize, 0.05, 0);
  xRoad.receiveShadow = true;
  cityGroup.add(xRoad);
  const xLine = new THREE.Mesh(lineGeo, lineMat);
  xLine.rotation.x = -Math.PI / 2;
  xLine.rotation.z = Math.PI / 2;
  xLine.position.set(i * gridSize, 0.06, 0);
  cityGroup.add(xLine);
}

// Generate Structured City Blocks
for (let bx = -blocks; bx < blocks; bx += 4) {
  for (let bz = -blocks; bz < blocks; bz += 4) {
    // Fill the 3x3 interior cells of this block
    for (let cx = 1; cx <= 3; cx++) {
      for (let cz = 1; cz <= 3; cz++) {
        // Skip some cells randomly to create interesting block shapes (alleys/plazas)
        if (Math.random() > 0.85) continue;

        const cellX = (bx + cx) * gridSize;
        const cellZ = (bz + cz) * gridSize;
        
        const dist = Math.sqrt(cellX * cellX + cellZ * cellZ);
        if (dist > 3500) continue; // Don't build too far out
        
        const maxHeight = Math.max(50, 700 - dist * 0.15);
        
        // Give the center cell (cx=2, cz=2) a much taller skyscraper
        const isCenter = (cx === 2 && cz === 2);
        
        const w = 35 + Math.random() * 20;
        const d = 35 + Math.random() * 20;
        const h = isCenter 
            ? 100 + Math.random() * maxHeight 
            : 30 + Math.random() * (maxHeight * 0.4);
            
        const mat = buildingMats[Math.floor(Math.random() * buildingMats.length)];
        // BoxGeometry face/material order is [+x, -x, +y(top), -y(bottom), +z, -z]
        const mesh = new THREE.Mesh(buildingGeo, [mat, mat, roofMat, roofMat, mat, mat]);
        mesh.scale.set(w, h, d);
        
        // Add a slight random offset so they aren't perfectly aligned, adding realism
        const ox = (Math.random() - 0.5) * 15;
        const oz = (Math.random() - 0.5) * 15;
        mesh.position.set(cellX + ox, h / 2, cellZ + oz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        // Adjust UVs so side-wall windows don't stretch vertically as buildings get taller.
        // (Vertices 8-15 are the top/bottom roof faces — leave those alone so the roof
        // texture isn't distorted by building height.)
        const g = buildingGeo.clone();
        const uvs = g.attributes.uv;
        for (let i = 0; i < uvs.count; i++) {
          if (i >= 8 && i <= 15) continue;
          uvs.setY(i, uvs.getY(i) * (h/50));
        }
        mesh.geometry = g;

        cityGroup.add(mesh);
        buildings.push(mesh);
      }
    }
  }
}

// Low-Poly Pine Trees
const treeTrunkGeo = new THREE.CylinderGeometry(0.8, 1.2, 8, 8);
const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x8B4513, roughness: 0.9 });
const treeTopGeo = new THREE.ConeGeometry(5, 14, 8);
const treeTopMat = new THREE.MeshStandardMaterial({ color: 0x2d8c2d, roughness: 0.8 });
const treeTopGeo2 = new THREE.ConeGeometry(4, 10, 8);

for (let i = 0; i < 400; i++) {
  const tx = (Math.random() - 0.5) * 5000;
  const tz = (Math.random() - 0.5) * 5000;
  
  // Don't place trees on roads (every 4th cell * 60 = 240 spacing)
  const nearRoadX = Math.abs(tx % 240) < 20 || Math.abs(tx % 240) > 220;
  const nearRoadZ = Math.abs(tz % 240) < 20 || Math.abs(tz % 240) > 220;
  if (nearRoadX || nearRoadZ) continue;
  
  // Don't place trees inside building blocks (check distance from block centers)
  let tooClose = false;
  for (let b = 0; b < buildings.length; b++) {
    const bx = buildings[b].position.x;
    const bz = buildings[b].position.z;
    if (Math.abs(tx - bx) < 40 && Math.abs(tz - bz) < 40) { tooClose = true; break; }
  }
  if (tooClose) continue;
  
  const treeGroup = new THREE.Group();
  const scale = 0.6 + Math.random() * 0.8;
  
  // Trunk
  const trunk = new THREE.Mesh(treeTrunkGeo, treeTrunkMat);
  trunk.position.y = 4 * scale;
  trunk.scale.set(scale, scale, scale);
  trunk.castShadow = true;
  treeGroup.add(trunk);
  
  // Bottom cone (larger)
  const top1 = new THREE.Mesh(treeTopGeo, treeTopMat);
  top1.position.y = 12 * scale;
  top1.scale.set(scale, scale, scale);
  top1.castShadow = true;
  treeGroup.add(top1);
  
  // Top cone (smaller, stacked)
  const top2 = new THREE.Mesh(treeTopGeo2, treeTopMat);
  top2.position.y = 20 * scale;
  top2.scale.set(scale, scale, scale);
  top2.castShadow = true;
  treeGroup.add(top2);
  
  treeGroup.position.set(tx, 0, tz);
  cityGroup.add(treeGroup);
}

// Cars, Vans and Buses
const cars = [];
// Bigger, more visible vehicle bodies (was 2x1.5x4.5 / 2.2x2x5.5 / 2.5x2.5x10)
const carGeo = new THREE.BoxGeometry(2.6, 2, 6);
const vanGeo = new THREE.BoxGeometry(3, 2.6, 7.5);
const busGeo = new THREE.BoxGeometry(3.4, 3.2, 13);

// A palette of car colors for visual variety (instead of one red car for everyone)
const carColors = [0xff4f5e, 0xffffff, 0x2b2b2b, 0xc9ced6, 0xffd54a, 0x35e08a, 0x4fb3ff, 0xff9800, 0x8b5cf6, 0x777777];
const carMats = carColors.map(c => new THREE.MeshStandardMaterial({
  color: c, roughness: 0.25, metalness: 0.75, emissive: new THREE.Color(c).multiplyScalar(0.05)
}));
const vanMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, roughness: 0.35, metalness: 0.4, emissive: 0x332200 });
const busMat = new THREE.MeshStandardMaterial({ color: 0x4fb3ff, roughness: 0.4, metalness: 0.2, emissive: 0x001133 });

function pickVehicle() {
  const roll = Math.random();
  if (roll > 0.88) return { geo: busGeo, mat: busMat, rideHeight: 1.6 };
  if (roll > 0.76) return { geo: vanGeo, mat: vanMat, rideHeight: 1.3 };
  return { geo: carGeo, mat: carMats[Math.floor(Math.random() * carMats.length)], rideHeight: 1.0 };
}

// Spawns one vehicle onto a specific road. `axis` is the direction it drives along
// ('x' for east-west roads, 'z' for north-south roads). `fixedCoord` is the road's
// centerline coordinate; `alongCoord` is where along that road it sits; `laneSign`
// picks which of the two lanes (and therefore which travel direction) it's in.
function spawnVehicle(axis, fixedCoord, alongCoord, laneSign) {
  const v = pickVehicle();
  const mesh = new THREE.Mesh(v.geo, v.mat);
  const laneOffset = laneSign * 5;
  if (axis === 'x') {
    mesh.position.set(alongCoord, v.rideHeight, fixedCoord + laneOffset);
    mesh.rotation.y = Math.PI / 2;
  } else {
    mesh.position.set(fixedCoord + laneOffset, v.rideHeight, alongCoord);
  }
  mesh.castShadow = true;
  // Occasional near-zero speed cars create visible "jams"; the rest flow normally.
  const jammed = Math.random() < 0.12;
  mesh.userData = { speed: jammed ? Math.random() * 3 : 15 + Math.random() * 25, dir: laneSign, axis };
  cityGroup.add(mesh);
  cars.push(mesh);
}

// Populate EVERY road (not just a random scatter) so no street is ever empty.
const ROAD_TRAFFIC_RANGE = 2900; // stay within the ±3000 wraparound used in animate()
const CARS_PER_ROAD = 22;        // dense enough to look like moving/jammed traffic on every street

for (let i = -blocks; i <= blocks; i += 4) {
  const roadZ = i * gridSize; // east-west road, fixed Z, traffic runs along X
  const roadX = i * gridSize; // north-south road, fixed X, traffic runs along Z
  const segment = (2 * ROAD_TRAFFIC_RANGE) / CARS_PER_ROAD;

  for (let c = 0; c < CARS_PER_ROAD; c++) {
    const alongX = -ROAD_TRAFFIC_RANGE + (c + Math.random() * 0.85) * segment;
    spawnVehicle('x', roadZ, alongX, c % 2 === 0 ? 1 : -1);

    const alongZ = -ROAD_TRAFFIC_RANGE + (c + Math.random() * 0.85) * segment;
    spawnVehicle('z', roadX, alongZ, c % 2 === 0 ? 1 : -1);
  }
}

// --------------------------------------------------------
// STREET LAMPPOSTS — lining both edges of every road
// --------------------------------------------------------
// Built with InstancedMesh (3 draw calls total) so thousands of posts stay cheap to render.
{
  const LAMP_RANGE = 1800;   // how far out along each road to place lamps
  const LAMP_SPACING = 120;  // distance between consecutive lampposts
  const ROAD_EDGE = 17;      // offset from road centerline (road is 30 wide) to the shoulder
  const STREET_SPACING = gridSize * 4; // 240 — distance between parallel cross-streets
  const INTERSECTION_CLEARANCE = 22;   // skip a lamp if it would land inside a crossing road (half-width 15 + margin)

  // True if `coord` (an X for a z-road lamp, or a Z for an x-road lamp) falls inside
  // the paved width of a perpendicular road crossing at this point — i.e. an intersection.
  function isAtIntersection(coord) {
    const mod = ((coord % STREET_SPACING) + STREET_SPACING) % STREET_SPACING;
    return mod < INTERSECTION_CLEARANCE || mod > (STREET_SPACING - INTERSECTION_CLEARANCE);
  }

  const lampTransforms = [];
  for (let i = -blocks; i <= blocks; i += 4) {
    const roadZ = i * gridSize;
    for (let x = -LAMP_RANGE; x <= LAMP_RANGE; x += LAMP_SPACING) {
      if (isAtIntersection(x)) continue; // don't drop a lamp in the middle of a crossing road
      lampTransforms.push({ x: x, z: roadZ + ROAD_EDGE, axis: 'z', side: -1 });
      lampTransforms.push({ x: x, z: roadZ - ROAD_EDGE, axis: 'z', side: 1 });
    }
    const roadX = i * gridSize;
    for (let z = -LAMP_RANGE; z <= LAMP_RANGE; z += LAMP_SPACING) {
      if (isAtIntersection(z)) continue; // don't drop a lamp in the middle of a crossing road
      lampTransforms.push({ x: roadX + ROAD_EDGE, z: z, axis: 'x', side: -1 });
      lampTransforms.push({ x: roadX - ROAD_EDGE, z: z, axis: 'x', side: 1 });
    }
  }

  const lampCount = lampTransforms.length;
  const lampPoleGeo = new THREE.CylinderGeometry(0.6, 0.8, 22, 6);
  const lampArmGeo = new THREE.BoxGeometry(6, 0.8, 0.8);
  const lampHeadGeo = new THREE.SphereGeometry(1.3, 8, 6);
  const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6, metalness: 0.6 });
  const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffdd88, emissiveIntensity: 1.4, roughness: 0.4 });

  const lampPoles = new THREE.InstancedMesh(lampPoleGeo, lampPoleMat, lampCount);
  const lampArms = new THREE.InstancedMesh(lampArmGeo, lampPoleMat, lampCount);
  const lampHeads = new THREE.InstancedMesh(lampHeadGeo, lampHeadMat, lampCount);
  lampPoles.castShadow = true;

  const dummy = new THREE.Object3D();
  lampTransforms.forEach((t, idx) => {
    // Pole (straight up out of the ground)
    dummy.position.set(t.x, 11, t.z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    lampPoles.setMatrixAt(idx, dummy.matrix);

    // Arm & head reach out over the road, perpendicular to the offset direction
    let ax = 0, az = 0, hx = 0, hz = 0, armRotY = 0;
    if (t.axis === 'z') { az = t.side * 3; hz = t.side * 6; armRotY = Math.PI / 2; }
    else { ax = t.side * 3; hx = t.side * 6; armRotY = 0; }

    dummy.position.set(t.x + ax, 21.5, t.z + az);
    dummy.rotation.set(0, armRotY, 0);
    dummy.updateMatrix();
    lampArms.setMatrixAt(idx, dummy.matrix);

    dummy.position.set(t.x + hx, 21, t.z + hz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    lampHeads.setMatrixAt(idx, dummy.matrix);
  });

  lampPoles.instanceMatrix.needsUpdate = true;
  lampArms.instanceMatrix.needsUpdate = true;
  lampHeads.instanceMatrix.needsUpdate = true;

  cityGroup.add(lampPoles, lampArms, lampHeads);
}

// --------------------------------------------------------
// DRONE MODEL LOADING (Procedural from CAD specifications)
// --------------------------------------------------------
const droneGroup = new THREE.Group();
scene.add(droneGroup);

let leftNacelleGroup, rightNacelleGroup, leftRotor, rightRotor, leftMat, rightMat, leftLight, rightLight;

function buildDroneFromCAD() {
    // Scale: OpenSCAD mm → Three.js world units
    const s = 0.007;
    
    // --- Materials (matching OpenSCAD colors) ---
    const fuseMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.3, metalness: 0.1 }); // whitesmoke
    const sensorMat = new THREE.MeshStandardMaterial({ color: 0x2f4f4f, roughness: 0.5, metalness: 0.2 }); // darkslategray
    const grayMat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5, metalness: 0.2 }); // gray (V-tail)
    const nacelleMat = new THREE.MeshStandardMaterial({ color: 0x696969, roughness: 0.6, metalness: 0.3 }); // dimgray
    const silverMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.2, metalness: 0.8 }); // silver
    const darkGrayMat = new THREE.MeshStandardMaterial({ color: 0xa9a9a9, roughness: 0.4, metalness: 0.3 }); // darkgray (hub)
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8, metalness: 0.1 }); // black

    // --- Coordinate mapping ---
    // OpenSCAD: X=forward, Y=lateral, Z=up
    // Three.js: X=lateral, Y=up, Z=-forward
    // So: SCAD(ox,oy,oz) → Three(oy*s, oz*s, -ox*s)
    
    const fuseGroup = new THREE.Group();
    droneGroup.add(fuseGroup);
    
    // =============================================
    // 1. FUSELAGE — hull() of 3 scaled spheres
    // =============================================
    // OpenSCAD hull() creates a smooth convex shape.
    // We approximate with a deformed sphere matching the hull envelope.
    // Nose:  translate([1100, 0, -50]) scale([1.5, 2.5, 0.4]) sphere(r=120) → X±180, Y±300, Z±48
    // Belly: translate([100, 0, 0])    scale([1.2, 1.2, 1])   sphere(r=300) → X±360, Y±360, Z±300
    // Tail:  translate([-1100, 0, 100]) scale([2, 1.5, 0.2])  sphere(r=150) → X±300, Y±225, Z±30
    
    function createFuselageGeo() {
        const points = [];
        
        // Helper to add sphere points to hull
        function addHullSphere(r, scale, pos) {
            const tempGeo = new THREE.SphereGeometry(r * s, 16, 16);
            // OpenSCAD scale: [x,y,z] -> Three: [lateral(y), up(z), forward(x)]
            tempGeo.scale(scale[1], scale[2], scale[0]);
            // OpenSCAD pos: [x,y,z] -> Three: [lateral(y), up(z), forward(-x)]
            tempGeo.translate(pos[1] * s, pos[2] * s, -pos[0] * s);
            
            const p = tempGeo.attributes.position;
            for(let i=0; i<p.count; i++) {
                points.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
            }
        }
        
        const fuse_length = 2600;
        const fuse_height = 600;
        
        // Nose: translate([fuse_length/2 - 200, 0, -50]) scale([1.5, 2.5, 0.4]) sphere(r=120)
        addHullSphere(120, [1.5, 2.5, 0.4], [fuse_length/2 - 200, 0, -50]);
        
        // Center Payload Belly: translate([100, 0, 0]) scale([1.2, 1.2, 1]) sphere(r=fuse_height/2)
        addHullSphere(fuse_height/2, [1.2, 1.2, 1], [100, 0, 0]);
        
        // Tail taper: translate([-fuse_length/2 + 200, 0, 100]) scale([2, 1.5, 0.2]) sphere(r=150)
        addHullSphere(150, [2, 1.5, 0.2], [-fuse_length/2 + 200, 0, 100]);
        
        return new THREE.ConvexGeometry(points);
    }
    
    const fuseGeo = createFuselageGeo();
    const fuseMesh = new THREE.Mesh(fuseGeo, fuseMat);
    // fuseMesh.scale.set(s, s, s); // Already scaled in addHullSphere
    fuseMesh.castShadow = true; fuseMesh.receiveShadow = true;
    fuseGroup.add(fuseMesh);
    
    // =============================================
    // 2. SENSOR SUITE — flush into nose
    // =============================================
    // translate([1200, 0, -50]) scale([1, 1.5, 0.3]) sphere(r=125)
    const sensorGeo = new THREE.SphereGeometry(1, 32, 16);
    const sensorMesh = new THREE.Mesh(sensorGeo, sensorMat);
    sensorMesh.position.set(0 * s, -50 * s, -1200 * s);  // SCAD(1200, 0, -50)
    sensorMesh.scale.set(1.5 * 125 * s, 0.3 * 125 * s, 1 * 125 * s); // (sy, sz, sx)
    sensorMesh.castShadow = true; sensorMesh.receiveShadow = true;
    fuseGroup.add(sensorMesh);
    
    // =============================================
    // 3. V-TAIL — two angled planes
    // =============================================
    const tailBase = new THREE.Group();
    tailBase.position.set(0, 150*s, 1000*s); // SCAD translate([-fuse_length/2 + 300, 0, 150]) -> [-1000, 0, 150] -> Three [0, 150*s, 1000*s]
    fuseGroup.add(tailBase);
    
    // SCAD cube([350, 500, 30]) -> Three: X(lateral)=500, Y(up)=30, Z(forward)=350
    const trueTailGeo = new THREE.BoxGeometry(500*s, 30*s, 350*s);
    
    // Right V-tail: rotate([35, 0, 0]) translate([-100, 250, 50])
    const rTailPivot = new THREE.Group();
    rTailPivot.rotation.z = THREE.MathUtils.degToRad(-35); // SCAD rotate X = 35 -> Three.js rotate -Z = -35
    const rTail = new THREE.Mesh(trueTailGeo, grayMat);
    rTail.position.set(250*s, 50*s, 100*s); // SCAD [-100, 250, 50] -> Three [250, 50, 100]
    rTail.castShadow = true; rTailPivot.add(rTail);
    tailBase.add(rTailPivot);
    
    // Left V-tail: rotate([-35, 0, 0]) translate([-100, -250, 50])
    const lTailPivot = new THREE.Group();
    lTailPivot.rotation.z = THREE.MathUtils.degToRad(35); // SCAD rotate X = -35 -> Three.js rotate -Z = 35
    const lTail = new THREE.Mesh(trueTailGeo, grayMat);
    lTail.position.set(-250*s, 50*s, 100*s); // SCAD [-100, -250, 50] -> Three [-250, 50, 100]
    lTail.castShadow = true; lTailPivot.add(lTail);
    tailBase.add(lTailPivot);
    
    // =============================================
    // 4. HIGH-WINGS with V-shape dihedral
    // =============================================
    const arm_span = 2800, wing_chord = 650, wing_thickness = 150, wing_dihedral = 400;
    const nacelle_offset = 450;
    const wingBaseZ = 220; // fuse_height/2 - 80
    
    // Wing hull: hull() of two spheres scale([13,1,3]) sphere(r=25)
    // Scale mapping: SCAD [13, 1, 3] -> Three [1, 3, 13] (lateral, up, forward)
    function createWingGeo(isRight) {
        const pts = [];
        const yDir = isRight ? 1 : -1;
        // Root sphere: translate([0, 0, 0])
        const rootGeo = new THREE.SphereGeometry(25*s, 16, 16);
        rootGeo.scale(1, 3, 13);
        const p1 = rootGeo.attributes.position;
        for(let i=0; i<p1.count; i++) pts.push(new THREE.Vector3(p1.getX(i), p1.getY(i), p1.getZ(i)));
        
        // Tip sphere: translate([0, ±arm_span/2, wing_dihedral])
        const tipGeo = new THREE.SphereGeometry(25*s, 16, 16);
        tipGeo.scale(1, 3, 13);
        tipGeo.translate(yDir * (arm_span/2)*s, wing_dihedral*s, 0); // SCAD(0, y, z) -> Three(y, z, 0)
        const p2 = tipGeo.attributes.position;
        for(let i=0; i<p2.count; i++) pts.push(new THREE.Vector3(p2.getX(i), p2.getY(i), p2.getZ(i)));
        
        return new THREE.ConvexGeometry(pts);
    }
    
    const rWing = new THREE.Mesh(createWingGeo(true), fuseMat);
    rWing.position.set(0, wingBaseZ*s, 0);
    rWing.castShadow = true; fuseGroup.add(rWing);
    
    const lWing = new THREE.Mesh(createWingGeo(false), fuseMat);
    lWing.position.set(0, wingBaseZ*s, 0);
    lWing.castShadow = true; fuseGroup.add(lWing);
    
    // =============================================
    // 5. LANDING STANDS
    // =============================================
    // SCAD: hull() { sphere at (100, y, -100) r=150, spheres at (±300, y, -500) r=40 }
    function createLandingStandGeo(scadY) {
        const pts = [];
        const addS = (pos, r) => {
            const geo = new THREE.SphereGeometry(r*s, 16, 16);
            geo.translate(pos[1]*s, pos[2]*s, -pos[0]*s);
            const attr = geo.attributes.position;
            for(let i=0; i<attr.count; i++) pts.push(new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i)));
        };
        addS([100, scadY, -100], 150);
        addS([300, scadY, -500], 40);
        addS([-300, scadY, -500], 40);
        return new THREE.ConvexGeometry(pts);
    }
    
    const rStand = new THREE.Mesh(createLandingStandGeo(275), fuseMat);
    rStand.castShadow = true; fuseGroup.add(rStand);
    
    const lStand = new THREE.Mesh(createLandingStandGeo(-275), fuseMat);
    lStand.castShadow = true; fuseGroup.add(lStand);
    
    // =============================================
    // 6. TILT NACELLES & DUCTED FANS
    // =============================================
    // Nacelle positions (relative to wing base):
    //   Right: SCAD (0, arm_span/2 + nacelle_offset, wing_dihedral) = (0, 1850, 400)
    //   Plus wing base Z offset: (0, 1850, 620)
    // In Three.js: (1850*s, 620*s, 0)
    
    function createNacelle(isRight) {
        const nacGroup = new THREE.Group();
        
        // --- Pivot Joint ---
        // cylinder(h=500, d=120) connecting nacelle to wingtip
        const pivotLen = (nacelle_offset + 50) * s;
        const pivotGeo = new THREE.CylinderGeometry(60 * s, 60 * s, pivotLen, 16);
        const pivot = new THREE.Mesh(pivotGeo, blackMat);
        // Pivot extends from wingtip towards nacelle center (along Three.js X / SCAD Y)
        pivot.position.set((isRight ? -1 : 1) * pivotLen / 2, 0, 0);
        pivot.rotation.z = Math.PI / 2; // align along X
        pivot.castShadow = true; nacGroup.add(pivot);
        
        // --- Nacelle Body ---
        // SCAD: hull() { cylinder(h=250, d=350) at (0,0,0), cylinder(h=50, d=150) at (-300,0,0) }
        const pts = [];
        const addCyl = (h, d, scadX) => {
            const geo = new THREE.CylinderGeometry(d/2*s, d/2*s, h*s, 16);
            geo.rotateX(Math.PI/2); // SCAD rotate([0,90,0]) means rotate around Y in SCAD -> Three.js rotate Z... wait, SCAD Y is Three.js X. 
            // In SCAD, rotate([0,90,0]) aligns cylinder along X. In Three.js, aligning along Z (SCAD X) means rotateX(90).
            geo.translate(0, 0, -scadX * s);
            const p = geo.attributes.position;
            for(let i=0; i<p.count; i++) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
        }
        addCyl(250, 350, 0);
        addCyl(50, 150, -300);
        
        const bodyGeo = new THREE.ConvexGeometry(pts);
        const body = new THREE.Mesh(bodyGeo, nacelleMat);
        body.castShadow = true; nacGroup.add(body);
        
        // --- Ducted Fan ---
        // translate([duct_height/2 + 100, 0, 0]) rotate([0,90,0]) → at SCAD X=225, facing X
        // SCAD X=225 → Three.js Z = -225*s
        const ductZ = -225 * s; // position along Three.js Z (forward)
        const ductH = 250 * s;
        const ductOuterR = 400 * s;
        const ductInnerR = 360 * s;
        
        // Outer cowl (open cylinder)
        const ductGeo = new THREE.CylinderGeometry(ductOuterR, ductOuterR, ductH, 32, 1, true);
        ductGeo.rotateX(Math.PI / 2); // align with Z
        const duct = new THREE.Mesh(ductGeo, silverMat.clone());
        duct.material.side = THREE.DoubleSide;
        duct.position.set(0, 0, ductZ);
        nacGroup.add(duct);
        
        // Intake lip (torus at front of duct)
        const lipGeo = new THREE.TorusGeometry((ductInnerR + ductOuterR) / 2, (ductOuterR - ductInnerR) / 2 + 5 * s, 16, 32);
        const lip = new THREE.Mesh(lipGeo, grayMat);
        lip.position.set(0, 0, ductZ - ductH / 2); // front edge
        nacGroup.add(lip);
        
        // Stator struts (5 struts as in OpenSCAD)
        const strutGeo2 = new THREE.BoxGeometry(ductInnerR * 0.9, 30 * s, 50 * s);
        for (let i = 0; i < 5; i++) {
            const strut = new THREE.Mesh(strutGeo2, grayMat);
            strut.rotation.z = i * (2 * Math.PI / 5);
            strut.position.set(0, 0, ductZ + ductH * 0.15); // slightly behind center
            nacGroup.add(strut);
        }
        
        // Emissive ring
        const ringGeo = new THREE.TorusGeometry(ductInnerR, 10 * s, 8, 32);
        const ringMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x000000 });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.set(0, 0, ductZ);
        nacGroup.add(ring);
        const light = new THREE.PointLight(0x000000, 0, 50);
        ring.add(light);
        
        // --- Rotor Assembly ---
        const rotor = new THREE.Group();
        rotor.position.set(0, 0, ductZ);
        
        // 7 blades, each: translate([ductInnerR/4, 0, ductH/4-20]) rotate([35,0,0]) cube([ductInnerR/2-10, 100, 15])
        const bladeHalfSpan = (720 / 2 - 10); // duct_inner_dia/2 - 10 = 350
        const bladeWidth = 100;
        const bladeThick = 15;
        const bladeGeo = new THREE.BoxGeometry(bladeHalfSpan * s, bladeWidth * s, bladeThick * s);
        bladeGeo.translate(bladeHalfSpan / 2 * s + (720 / 4) * s, 0, 0); // offset outward from center
        
        for (let i = 0; i < 7; i++) {
            const blade = new THREE.Mesh(bladeGeo, blackMat);
            blade.rotation.z = i * (2 * Math.PI / 7);
            blade.rotation.x = THREE.MathUtils.degToRad(35); // pitch
            blade.castShadow = true;
            rotor.add(blade);
        }
        
        // Motor Hub: cylinder(h=150, d=200)
        const hubGeo = new THREE.CylinderGeometry(100 * s, 100 * s, 150 * s, 32);
        hubGeo.rotateX(Math.PI / 2);
        const hub = new THREE.Mesh(hubGeo, darkGrayMat);
        rotor.add(hub);
        
        // Spinner cone: cylinder(h=80, d1=200, d2=0) at front of hub
        const spinGeo = new THREE.ConeGeometry(100 * s, 80 * s, 32);
        spinGeo.rotateX(-Math.PI / 2); // point forward (-Z)
        const spinner = new THREE.Mesh(spinGeo, silverMat);
        spinner.position.set(0, 0, -75 * s - 40 * s); // in front of hub
        rotor.add(spinner);
        
        nacGroup.add(rotor);
        
        return { group: nacGroup, rotor, ringMat, light };
    }
    
    // Position nacelles at wingtips + offset
    // SCAD: (0, ±1850, 620) → Three.js: (±1850*s, 620*s, 0)
    const rightN = createNacelle(true);
    rightN.group.position.set((arm_span / 2 + nacelle_offset) * s, (wingBaseZ + wing_dihedral) * s, 0);
    droneGroup.add(rightN.group);
    
    const leftN = createNacelle(false);
    leftN.group.position.set(-(arm_span / 2 + nacelle_offset) * s, (wingBaseZ + wing_dihedral) * s, 0);
    droneGroup.add(leftN.group);
    
    leftNacelleGroup = leftN.group; rightNacelleGroup = rightN.group;
    leftRotor = leftN.rotor; rightRotor = rightN.rotor;
    leftMat = leftN.ringMat; rightMat = rightN.ringMat;
    leftLight = leftN.light; rightLight = rightN.light;
    
    // Offset fuseGroup so the drone center-of-mass is at droneGroup origin
    fuseGroup.position.set(0, -wingBaseZ * s, 0);
}
buildDroneFromCAD();

// --------------------------------------------------------
// RENDER LOOP & UPDATE
// --------------------------------------------------------
const PHASE_NAMES = ['SPOOL UP', 'CLIMB', 'TRANSITION', 'CRUISE', 'DECELERATE', 'LANDING'];
let lastTime = performance.now();
let totalPowerUsed = 0;

function updateUI(s) {
  const { total } = getDurations();
  
  // Left Panel parameters
  document.getElementById('val-transdur').innerText = parseFloat(els.transdur.value).toFixed(1) + ' s';
  document.getElementById('val-payload').innerText = els.payload.value + ' kg';
  document.getElementById('val-cruise').innerText = els.cruisespeed.value + ' km/h';
  document.getElementById('val-cruisealt').innerText = els.cruisealt.value + ' m';
  
  // Right Panel Telemetry
  const phaseNames = ['SPOOL UP', 'VERTICAL CLIMB', 'TRANSITION', 'HORIZONTAL CRUISE', 'DECELERATE', 'LANDING'];
  document.getElementById('readout-phase').innerHTML = phaseNames[s.phase];
  
  // Re-color phase text based on phase
  const phaseEl = document.getElementById('readout-phase');
  phaseEl.className = 'value'; // Reset
  if (s.phase === 1) phaseEl.classList.add('color-climb');
  else if (s.phase === 2) phaseEl.classList.add('color-trans');
  else if (s.phase === 3) phaseEl.classList.add('color-cruise');
  else if (s.phase === 4 || s.phase === 5) phaseEl.classList.add('color-desc');
  else phaseEl.classList.add('color-spool');

  document.getElementById('val-vel').innerHTML = Math.round(s.vel) + '<small>km/h</small>';
  document.getElementById('readout-tilt').innerHTML = s.tilt.toFixed(1) + '&deg;';
  document.getElementById('val-alt').innerHTML = Math.round(s.alt) + '<small>m</small>';
  document.getElementById('readout-shear').innerHTML = s.tauGyro.toFixed(1) + ' <small>N&middot;m</small>';
  document.getElementById('readout-gyro').innerHTML = '0.0 <small>N&middot;m</small>'; 
  
  // Formulas Box
  document.getElementById('formula-val').innerHTML = '&nbsp;&nbsp;&nbsp;&nbsp;' + s.tauGyro.toFixed(1) + ' N&middot;m per motor';
  document.getElementById('formula-net').innerHTML = '&nbsp;&nbsp;&nbsp;&nbsp;(+' + s.tauGyro.toFixed(1) + ') + (-' + s.tauGyro.toFixed(1) + ') = 0.0 N&middot;m';

  // Time display
  document.getElementById('time-display').innerText = state.t.toFixed(1) + 's / ' + total.toFixed(1) + 's';
  
  document.getElementById('val-vel2').innerHTML = Math.round(s.vel) + '<small>km/h</small>';
  document.getElementById('val-alt2').innerHTML = Math.round(s.alt) + '<small>m</small>';

  // Phase Banner
  document.getElementById('phase-banner').innerText = 'PHASE ' + (s.phase + 1) + ' \u00B7 ' + phaseNames[s.phase];
}

function updateChart() {
  const { total } = getDurations();
  const ctx = els.chart.getContext('2d');
  const w = els.chart.width;
  const h = els.chart.height;
  
  // Clear and draw center line
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
  ctx.stroke();

  // Max bounds for scaling each line to fit the canvas height
  const maxVel = 150;
  const maxAlt = 300;
  const maxTilt = 90;
  const maxShear = 100;

  // Pre-calculate state across the timeline width
  const states = [];
  for (let i = 0; i < w; i++) {
    const t = (i / w) * total;
    states.push(computeState(t));
  }

  // Helper to draw a line up to the current time
  const drawLine = (color, valueFn, maxVal) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < w; i++) {
      const t = (i / w) * total;
      if (t > state.t) break; // Real-time drawing limit
      
      const s = states[i];
      // padding: keep lines between 5% and 95% of height
      const normalized = Math.max(0, Math.min(1, valueFn(s) / maxVal));
      const y = h - (normalized * (h * 0.9) + (h * 0.05));
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  };

  // Draw the 4 physics lines matching the CSS legend colors
  drawLine('#4fb3ff', s => s.vel, maxVel);        // Velocity (Blue)
  drawLine('#ff9800', s => s.alt, maxAlt);        // Altitude (Orange)
  drawLine('#35e08a', s => s.tilt, maxTilt);      // Tilt (Green)
  drawLine('#ff4f5e', s => Math.abs(s.tauGyro), maxShear); // Shear (Red)
  
  // Draw current playback time scrubber line
  const cx = (state.t / total) * w;
  ctx.beginPath();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
  ctx.stroke();
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  const { total } = getDurations();

  if (state.playing && !state.dragging) {
    state.t += dt * state.speed;
    if (state.t > total) {
      state.t = 0; 
      totalPowerUsed = 0;
    }
    const s = computeState(state.t);
    totalPowerUsed += s.powerDraw * dt;
    state.battery = Math.max(0, 100 - (totalPowerUsed / 5));
    document.getElementById('val-bat').innerHTML = state.battery.toFixed(1) + '<small>%</small>';
  }

  const s = computeState(state.t);
  const pathData = getPathData(state.t);
  
  if (droneGroup) {
    // Map altitude securely above the curve point (offset by 5.25 so the skids rest perfectly on ground)
    droneGroup.position.set(pathData.pt.x, s.alt + 5.25, pathData.pt.z);
    
    // lookAt points the +Z axis towards the target. 
    // Since our nose is at -Z, we want the +Z axis (the tail) to point BACKWARDS.
    // So we subtract the tangent vector from the position!
    const lookTarget = droneGroup.position.clone().sub(pathData.tangent);
    droneGroup.lookAt(lookTarget);
  }
  
  // Apply physics to parts
  const tiltRad = s.tilt * Math.PI / 180;
  leftNacelleGroup.rotation.x = tiltRad;
  rightNacelleGroup.rotation.x = tiltRad;
  
  const spinSpeed = 20;
  leftRotor.rotation.z += spinSpeed * dt;
  rightRotor.rotation.z -= spinSpeed * dt;
  
  let emColor = new THREE.Color(0x35e08a);
  let emIntensity = 0;
  if (s.tauGyro > 40) {
      emColor.setHex(0xff4f5e);
      emIntensity = 1;
  } else if (s.tauGyro > 22) {
      emColor.setHex(0xffb020);
      emIntensity = 0.8;
  }
  leftMat.emissive = emColor; leftMat.emissiveIntensity = emIntensity;
  rightMat.emissive = emColor; rightMat.emissiveIntensity = emIntensity;
  leftLight.color = emColor; leftLight.intensity = emIntensity;
  rightLight.color = emColor; rightLight.intensity = emIntensity;

  let camOffset;
  let targetLookPos;
  if (window.viewMode === '1st') {
    // 1st person view (cockpit): slightly ahead of the nose (nose is -Z)
    camOffset = new THREE.Vector3(0, 5, -30);
    if(droneGroup) camOffset.applyQuaternion(droneGroup.quaternion);
    const targetCamPos = new THREE.Vector3(pathData.pt.x, s.alt + 5.25, pathData.pt.z).add(camOffset);
    camera.position.lerp(targetCamPos, 0.3); // faster tracking for 1st person
    
    // Look directly ahead along the flight path tangent
    const forward = pathData.tangent.clone().multiplyScalar(100);
    targetLookPos = new THREE.Vector3(pathData.pt.x, s.alt + 5.25, pathData.pt.z).add(forward);
  } else {
    // 3rd person view
    camOffset = new THREE.Vector3(0, 30, 80);
    if(droneGroup) camOffset.applyQuaternion(droneGroup.quaternion);
    const targetCamPos = new THREE.Vector3(pathData.pt.x, s.alt + 5.25, pathData.pt.z).add(camOffset);
    camera.position.lerp(targetCamPos, 0.1);
    
    // Look directly at the drone
    targetLookPos = new THREE.Vector3(pathData.pt.x, s.alt + 5.25, pathData.pt.z);
  }
  controls.target.lerp(targetLookPos, 0.1);
  controls.update();

  cars.forEach(car => {
    if (car.userData.axis === 'z') {
      car.position.z += car.userData.speed * car.userData.dir * dt;
      if (car.position.z > 3000) car.position.z = -3000;
      if (car.position.z < -3000) car.position.z = 3000;
    } else {
      car.position.x += car.userData.speed * car.userData.dir * dt;
      if (car.position.x > 3000) car.position.x = -3000;
      if (car.position.x < -3000) car.position.x = 3000;
    }
  });

  updateUI(s);
  updateChart();
  renderer.render(scene, camera);
}

// --------------------------------------------------------
// EVENT LISTENERS
// --------------------------------------------------------
[els.transdur, els.payload, els.cruisespeed, els.cruisealt].forEach(el => {
  if (el) el.addEventListener('input', regenerateWorld);
});

els.playBtn.addEventListener('click', () => {
  state.playing = !state.playing;
  els.playBtn.innerText = state.playing ? 'Pause' : 'Play Mission';
});

els.resetBtn.addEventListener('click', () => {
  state.t = 0;
  totalPowerUsed = 0;
  state.battery = 100;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

regenerateWorld();
animate();
