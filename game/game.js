// Sky Runner 3D — self-contained arcade flying game over a real Manhattan building layout
// (pulled from OpenStreetMap via the free Overpass API), with taxi/takeoff/landing physics
// and a plane-select screen. No dependency on the parent site; only talks to the DOM inside
// game/index.html. Uses Three.js (loaded via importmap in index.html).
import * as THREE from "three";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
var container = document.getElementById("three-container");
var scoreEl = document.getElementById("score");
var bestEl = document.getElementById("best");
var statusEl = document.getElementById("status");
var altEl = document.getElementById("alt");
var spdEl = document.getElementById("spd");
var overlay = document.getElementById("overlay");
var loadingMsg = document.getElementById("loading-msg");
var readyPanel = document.getElementById("ready-panel");
var overlayMsg = document.getElementById("overlay-msg");
var planeSelectEl = document.getElementById("plane-select");
var startBtn = document.getElementById("start-btn");
var toastEl = document.getElementById("toast");
var joystickBase = document.getElementById("joystick-base");
var joystickKnob = document.getElementById("joystick-knob");
var boostBtn = document.getElementById("boost-btn");

var STORAGE_KEY = "sky-runner-3d-nyc-best";
var CACHE_KEY = "sky-runner-3d-nyc-osm-cache-v1";
var best = Number(localStorage.getItem(STORAGE_KEY)) || 0;
bestEl.textContent = "Best: " + best;

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
container.appendChild(renderer.domElement);

var SKY_COLOR = 0x9fc6ea;
var scene = new THREE.Scene();
scene.background = new THREE.Color(SKY_COLOR);
scene.fog = new THREE.Fog(SKY_COLOR, 260, 1100);

var camera = new THREE.PerspectiveCamera(70, 1, 0.5, 3000);

function resize() {
  var w = Math.max(1, container.clientWidth);
  var h = Math.max(1, container.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------
scene.add(new THREE.AmbientLight(0xfff6e8, 0.75));
var sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
sun.position.set(300, 400, 150);
scene.add(sun);
var skyBounce = new THREE.DirectionalLight(0xcfe3f7, 0.25);
skyBounce.position.set(-250, 120, -180);
scene.add(skyBounce);

// ---------------------------------------------------------------------------
// World constants — a real slice of Manhattan (Flatiron / Madison Square area)
// ---------------------------------------------------------------------------
var BBOX = { south: 40.7385, west: -73.995, north: 40.7465, east: -73.9845 };
var CENTER_LAT = (BBOX.south + BBOX.north) / 2;
var CENTER_LON = (BBOX.west + BBOX.east) / 2;
var EARTH_R = 6371000;
var TOWN_HALF = 460;
var CEILING_Y = 320;
var GROUND_MIN_Y = 3;

function project(lat, lon) {
  var x = (lon - CENTER_LON) * Math.cos((CENTER_LAT * Math.PI) / 180) * (Math.PI / 180) * EARTH_R;
  var z = (CENTER_LAT - lat) * (Math.PI / 180) * EARTH_R;
  return { x: x, z: z };
}

// Runway sits at the world origin, oriented along the X axis. Any real building
// footprint overlapping it is skipped so there's always a clear strip to land on.
var RUNWAY_LENGTH = 220;
var RUNWAY_WIDTH = 30;
var RUNWAY = {
  minX: -RUNWAY_LENGTH / 2,
  maxX: RUNWAY_LENGTH / 2,
  minZ: -RUNWAY_WIDTH / 2,
  maxZ: RUNWAY_WIDTH / 2,
};
var RUNWAY_CLEAR = { // slightly larger, used to keep real buildings off the strip
  minX: RUNWAY.minX - 12,
  maxX: RUNWAY.maxX + 12,
  minZ: RUNWAY.minZ - 12,
  maxZ: RUNWAY.maxZ + 12,
};

// Collision uses each building's real footprint polygon (not just its bounding box) —
// Manhattan buildings are rarely axis-aligned rectangles, so a bounding-box check alone
// flags empty street space as "inside a building" for any angled or irregular footprint.
var buildings = []; // { points:[{x,z}...], minX,maxX,minZ,maxZ, height }
var buildingsGroup = new THREE.Group();
scene.add(buildingsGroup);

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------
function makeGroundTexture() {
  var size = 512;
  var c = document.createElement("canvas");
  c.width = c.height = size;
  var g = c.getContext("2d");
  g.fillStyle = "#4a4d52";
  g.fillRect(0, 0, size, size);
  // subtle asphalt speckle
  for (var i = 0; i < 2200; i++) {
    var shade = 60 + Math.floor(Math.random() * 40);
    g.fillStyle = "rgba(" + shade + "," + shade + "," + (shade + 4) + "," + (0.15 + Math.random() * 0.2) + ")";
    var px = Math.random() * size, py = Math.random() * size;
    g.fillRect(px, py, 1.4, 1.4);
  }
  // faint block/sidewalk seams
  g.strokeStyle = "rgba(200, 200, 200, 0.12)";
  g.lineWidth = 2;
  var cell = size / 8;
  for (var x = 0; x <= size; x += cell) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, size);
    g.stroke();
  }
  for (var y = 0; y <= size; y += cell) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y);
    g.stroke();
  }
  var tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TOWN_HALF / 30, TOWN_HALF / 30);
  return tex;
}

var ground = new THREE.Mesh(
  new THREE.PlaneGeometry(TOWN_HALF * 2.4, TOWN_HALF * 2.4),
  new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ---------------------------------------------------------------------------
// Runway mesh — asphalt strip with a canvas-drawn centerline + threshold markings
// ---------------------------------------------------------------------------
function makeRunwayTexture() {
  var w = 1024, h = 140;
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  var g = c.getContext("2d");
  g.fillStyle = "#333538";
  g.fillRect(0, 0, w, h);
  for (var i = 0; i < 900; i++) {
    var shade = 40 + Math.floor(Math.random() * 25);
    g.fillStyle = "rgba(" + shade + "," + shade + "," + shade + "," + (0.2 + Math.random() * 0.2) + ")";
    g.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
  }
  g.strokeStyle = "#e8e8e0";
  g.lineWidth = 6;
  g.setLineDash([34, 26]);
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = "#e8e8e0";
  for (var side = 0; side < 2; side++) {
    var baseX = side === 0 ? 30 : w - 30 - 60;
    for (var j = 0; j < 6; j++) {
      g.fillRect(baseX + j * 12, 14, 6, h - 28);
    }
  }
  var tex = new THREE.CanvasTexture(c);
  return tex;
}

var runwayMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(RUNWAY_LENGTH, RUNWAY_WIDTH),
  new THREE.MeshStandardMaterial({ map: makeRunwayTexture(), roughness: 0.9 })
);
runwayMesh.rotation.x = -Math.PI / 2;
runwayMesh.position.y = 0.06;
scene.add(runwayMesh);

// runway edge lights — real airports use small warm-white lights along the strip
var edgeLightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xfff2cc, emissiveIntensity: 0.6 });
for (var lx = RUNWAY.minX + 6; lx <= RUNWAY.maxX - 6; lx += 18) {
  [RUNWAY.minZ - 2, RUNWAY.maxZ + 2].forEach(function (lz) {
    var light = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), edgeLightMat);
    light.position.set(lx, 0.6, lz);
    scene.add(light);
  });
}

// ---------------------------------------------------------------------------
// Real Manhattan buildings via OpenStreetMap Overpass API, with a procedural
// fallback if the fetch fails (offline, blocked, rate-limited, etc).
// ---------------------------------------------------------------------------
// Realistic daylight building materials — muted concrete/brick/glass tones rather than
// an arcade neon palette. Real OSM building:colour tags are used when a building has one.
var HEIGHT_PALETTE = [
  { max: 20, color: 0x9c9184 },
  { max: 40, color: 0x8f97a3 },
  { max: 80, color: 0x7d93ab },
  { max: 140, color: 0x6c86a3 },
  { max: 99999, color: 0x5a7396 },
];
function colorForHeight(h) {
  for (var i = 0; i < HEIGHT_PALETTE.length; i++) {
    if (h <= HEIGHT_PALETTE[i].max) return HEIGHT_PALETTE[i].color;
  }
  return HEIGHT_PALETTE[HEIGHT_PALETTE.length - 1].color;
}
function colorForBuilding(tags, height) {
  if (tags && tags["building:colour"]) {
    try {
      return new THREE.Color(tags["building:colour"]).getHex();
    } catch (e) {
      /* invalid color string — fall through to the height-based palette */
    }
  }
  return colorForHeight(height);
}
var materialCache = {};
function materialFor(hexColor) {
  if (!materialCache[hexColor]) {
    materialCache[hexColor] = new THREE.MeshStandardMaterial({ color: hexColor, roughness: 0.85, metalness: 0.1 });
  }
  return materialCache[hexColor];
}

function overlapsRunway(minX, maxX, minZ, maxZ) {
  return (
    minX < RUNWAY_CLEAR.maxX && maxX > RUNWAY_CLEAR.minX && minZ < RUNWAY_CLEAR.maxZ && maxZ > RUNWAY_CLEAR.minZ
  );
}

function addBuildingFromFootprint(points, height, colorHex) {
  if (points.length < 3) return;
  var shape = new THREE.Shape();
  // Shape coordinates are pre-negated on Z: ExtrudeGeometry lays the shape out in the
  // XY plane, and rotateX(-90deg) below (used to stand the extrusion up along world Y)
  // also flips Z, so negating here up front is what makes the rendered mesh land at the
  // same (x,z) as the `points` this building's collision check uses — without it the
  // mesh renders as a mirror image of its own collision volume.
  shape.moveTo(points[0].x, -points[0].z);
  for (var i = 1; i < points.length; i++) shape.lineTo(points[i].x, -points[i].z);

  var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (var j = 0; j < points.length; j++) {
    minX = Math.min(minX, points[j].x); maxX = Math.max(maxX, points[j].x);
    minZ = Math.min(minZ, points[j].z); maxZ = Math.max(maxZ, points[j].z);
  }
  if (overlapsRunway(minX, maxX, minZ, maxZ)) return;
  if (Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minZ), Math.abs(maxZ)) > TOWN_HALF) return;

  var geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  var mesh = new THREE.Mesh(geom, materialFor(colorHex));
  buildingsGroup.add(mesh);

  buildings.push({ points: points, minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, height: height });
}

function buildFromOsmElements(elements) {
  var count = 0;
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var geom = el.geometry;
    var tags = el.tags || {};
    if (!geom || geom.length < 3) continue;

    var height = parseFloat(tags.height);
    if (!isFinite(height)) {
      var levels = parseFloat(tags["building:levels"]);
      height = isFinite(levels) ? levels * 3.2 : 12 + Math.random() * 14;
    }
    height = Math.max(6, Math.min(280, height));

    var pts = geom.map(function (pt) { return project(pt.lat, pt.lon); });
    // drop the closing duplicate point OSM ways include
    if (pts.length > 1) {
      var a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < 0.001 && Math.abs(a.z - b.z) < 0.001) pts.pop();
    }
    addBuildingFromFootprint(pts, height, colorForBuilding(tags, height));
    count++;
  }
  return count;
}

function buildFallbackTown() {
  var BLOCK = 60;
  var cells = Math.floor((TOWN_HALF * 2) / BLOCK);
  var start = -TOWN_HALF + BLOCK / 2;
  for (var ix = 0; ix < cells; ix++) {
    for (var iz = 0; iz < cells; iz++) {
      var cx = start + ix * BLOCK;
      var cz = start + iz * BLOCK;
      var footprint = 26 + Math.random() * 10;
      var height = 14 + Math.random() * 55;
      var half = footprint / 2;
      var pts = [
        { x: cx - half, z: cz - half },
        { x: cx + half, z: cz - half },
        { x: cx + half, z: cz + half },
        { x: cx - half, z: cz + half },
      ];
      addBuildingFromFootprint(pts, height, colorForHeight(height));
    }
  }
}

function fetchOsmBuildings() {
  var query =
    "[out:json][timeout:25];(way[\"building\"](" +
    BBOX.south + "," + BBOX.west + "," + BBOX.north + "," + BBOX.east + "););out body geom;";
  var cached = null;
  try {
    var raw = localStorage.getItem(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    cached = null;
  }
  if (cached && cached.elements) {
    return Promise.resolve(cached.elements);
  }
  return fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
  })
    .then(function (res) {
      if (!res.ok) throw new Error("overpass http " + res.status);
      return res.json();
    })
    .then(function (data) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ elements: data.elements }));
      } catch (e) {
        /* storage full/unavailable — fine, just skip caching */
      }
      return data.elements;
    });
}

var worldReady = false;
fetchOsmBuildings()
  .then(function (elements) {
    var n = buildFromOsmElements(elements);
    if (n === 0) throw new Error("no buildings returned");
  })
  .catch(function () {
    buildingsGroup.clear();
    buildings.length = 0;
    buildFallbackTown();
  })
  .then(function () {
    worldReady = true;
    loadingMsg.style.display = "none";
    readyPanel.style.display = "flex";
  });

// ---------------------------------------------------------------------------
// Plane presets + model builder
// ---------------------------------------------------------------------------
var PLANE_PRESETS = [
  {
    name: "Cruiser",
    stats: "Balanced • easy to fly",
    bodyColor: 0x00f0ff,
    accentColor: 0xff2e88,
    scale: 1,
    cruiseSpeed: 42,
    boostSpeed: 78,
    turnRate: 1.6,
    pitchRate: 1.1,
    takeoffSpeed: 30,
    groundAccel: 20,
  },
  {
    name: "Falcon",
    stats: "Fast • less nimble",
    bodyColor: 0xff5a3c,
    accentColor: 0xffd400,
    scale: 0.88,
    cruiseSpeed: 56,
    boostSpeed: 100,
    turnRate: 1.3,
    pitchRate: 0.95,
    takeoffSpeed: 42,
    groundAccel: 27,
  },
  {
    name: "Nimbus",
    stats: "Agile • easy landings",
    bodyColor: 0x7bff5a,
    accentColor: 0xffd400,
    scale: 1.18,
    cruiseSpeed: 33,
    boostSpeed: 58,
    turnRate: 2.1,
    pitchRate: 1.5,
    takeoffSpeed: 22,
    groundAccel: 16,
  },
];

function buildPlaneMesh(preset) {
  var group = new THREE.Group();
  var bodyMat = new THREE.MeshStandardMaterial({ color: preset.bodyColor, roughness: 0.4, metalness: 0.3 });
  var accentMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.4, metalness: 0.3 });

  var fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 3.2, 4, 8), bodyMat);
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);

  var nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.4, 8), accentMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -2.9;
  group.add(nose);

  var wing = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.18, 1.4), bodyMat);
  wing.position.set(0, -0.1, 0.1);
  group.add(wing);

  var tailWing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.15, 0.8), bodyMat);
  tailWing.position.set(0, 0.1, 2.5);
  group.add(tailWing);

  var tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 1.1), accentMat);
  tailFin.position.set(0, 0.7, 2.6);
  group.add(tailFin);

  var cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.55, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x0a1226, roughness: 0.1, metalness: 0.6 })
  );
  cockpit.position.set(0, 0.7, -0.4);
  group.add(cockpit);

  var gearMat = new THREE.MeshStandardMaterial({ color: 0x111722, roughness: 0.6 });
  [[-1.6, -1.6], [1.6, -1.6], [0, 2]].forEach(function (p) {
    var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 8), gearMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(p[0], -1.1, p[1]);
    group.add(wheel);
  });

  group.scale.setScalar(preset.scale);
  return group;
}

var selectedPresetIndex = 0;
var plane = buildPlaneMesh(PLANE_PRESETS[selectedPresetIndex]);
scene.add(plane);

function selectPreset(index) {
  selectedPresetIndex = index;
  scene.remove(plane);
  plane = buildPlaneMesh(PLANE_PRESETS[index]);
  plane.position.set(RUNWAY.minX + 15, 0.9, 0);
  plane.rotation.set(0, -Math.PI / 2, 0);
  scene.add(plane);
  var cards = planeSelectEl.querySelectorAll(".plane-card");
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.toggle("selected", i === index);
  }
}

PLANE_PRESETS.forEach(function (preset, index) {
  var card = document.createElement("button");
  card.type = "button";
  card.className = "plane-card" + (index === 0 ? " selected" : "");
  card.innerHTML =
    '<span class="plane-name">' + preset.name + "</span>" +
    '<span class="plane-stats">' + preset.stats + "</span>";
  card.addEventListener("click", function () { selectPreset(index); });
  planeSelectEl.appendChild(card);
});
selectPreset(0);

// third-person chase camera state (smoothed)
var camPos = new THREE.Vector3();
var camLook = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Rings — collectible checkpoints
// ---------------------------------------------------------------------------
var RING_COUNT = 10;
var RING_RADIUS = 9;
var rings = [];
var ringsGroup = new THREE.Group();
scene.add(ringsGroup);

function placeRing(ring) {
  var x = (Math.random() * 2 - 1) * (TOWN_HALF - 40);
  var z = (Math.random() * 2 - 1) * (TOWN_HALF - 40);
  var y = 22 + Math.random() * 90;
  ring.mesh.position.set(x, y, z);
  ring.mesh.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2 + (Math.random() - 0.5) * 0.6);
  ring.normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.mesh.quaternion).normalize();
}

for (var i = 0; i < RING_COUNT; i++) {
  var ringMesh = new THREE.Mesh(
    new THREE.TorusGeometry(RING_RADIUS, 0.6, 10, 24),
    new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff7a1a, emissiveIntensity: 0.4, roughness: 0.5 })
  );
  ringsGroup.add(ringMesh);
  var ring = { mesh: ringMesh, normal: new THREE.Vector3() };
  placeRing(ring);
  rings.push(ring);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
var GAME_KEYS = ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
var keys = {};
window.addEventListener("keydown", function (e) {
  keys[e.code] = true;
  if (GAME_KEYS.indexOf(e.code) !== -1) e.preventDefault();
});
window.addEventListener("keyup", function (e) {
  keys[e.code] = false;
});

var joystickActive = false;
var joystickVec = { x: 0, y: 0 };
var joystickId = null;
var JOY_MAX = 42;

function joyStart(e) {
  joystickActive = true;
  joystickId = e.pointerId;
  joystickBase.setPointerCapture(e.pointerId);
}
function joyMove(e) {
  if (!joystickActive || e.pointerId !== joystickId) return;
  var rect = joystickBase.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  var dx = e.clientX - cx;
  var dy = e.clientY - cy;
  var dist = Math.min(JOY_MAX, Math.hypot(dx, dy));
  var angle = Math.atan2(dy, dx);
  dx = Math.cos(angle) * dist;
  dy = Math.sin(angle) * dist;
  joystickKnob.style.transform = "translate(" + dx + "px," + dy + "px)";
  joystickVec.x = dx / JOY_MAX;
  joystickVec.y = dy / JOY_MAX;
}
function joyEnd(e) {
  if (e.pointerId !== joystickId) return;
  joystickActive = false;
  joystickId = null;
  joystickVec.x = 0;
  joystickVec.y = 0;
  joystickKnob.style.transform = "translate(0,0)";
}
joystickBase.addEventListener("pointerdown", joyStart);
joystickBase.addEventListener("pointermove", joyMove);
joystickBase.addEventListener("pointerup", joyEnd);
joystickBase.addEventListener("pointercancel", joyEnd);

var boosting = false;
boostBtn.addEventListener("pointerdown", function (e) {
  e.preventDefault();
  boosting = true;
});
boostBtn.addEventListener("pointerup", function () {
  boosting = false;
});
boostBtn.addEventListener("pointercancel", function () {
  boosting = false;
});

// ---------------------------------------------------------------------------
// Flight state + physics
// ---------------------------------------------------------------------------
var state = "ready"; // ready | playing | over
var grounded = true;
var yaw, pitch, roll, speed, score;
var TURN_RATE_BASE = 1.6;
var PITCH_RATE_BASE = 1.1;
var MAX_PITCH = Math.PI / 3;
var GROUND_Y = 0.9;
var LANDING_MAX_TILT = 0.35;

var stats; // active plane's tuning, set on start
var airborneElapsed = 0; // guards against rapidly re-triggering the landing bonus by skipping/bouncing

function resetFlight() {
  stats = PLANE_PRESETS[selectedPresetIndex];
  plane.position.set(RUNWAY.minX + 15, GROUND_Y, 0);
  yaw = -Math.PI / 2; // faces +X, down the runway
  pitch = 0;
  roll = 0;
  speed = 0;
  grounded = true;
  score = 0;
  scoreEl.textContent = "Score: 0";
  statusEl.textContent = "ON RUNWAY";
  for (var i = 0; i < rings.length; i++) placeRing(rings[i]);
  camPos.copy(plane.position);
  camLook.copy(plane.position);
}
resetFlight();

var forwardVec = new THREE.Vector3();
var tmpVec = new THREE.Vector3();
var toastTimer = 0;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  toastTimer = 1.6;
}

// Real footprints aren't axis-aligned rectangles, so collision does a proper
// point-in-polygon test (buffered by roughly the plane's radius) against the actual
// building shape, only for buildings a cheap bounding-box + height check can't rule out.
var COLLISION_BUFFER = 2.4;
function distPointToSegment(px, pz, ax, az, bx, bz) {
  var abx = bx - ax, abz = bz - az;
  var apx = px - ax, apz = pz - az;
  var abLen2 = abx * abx + abz * abz;
  var t = abLen2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLen2)) : 0;
  var cx = ax + abx * t, cz = az + abz * t;
  var dx = px - cx, dz = pz - cz;
  return Math.sqrt(dx * dx + dz * dz);
}
function pointNearPolygon(px, pz, points, buffer) {
  var inside = false;
  for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
    var xi = points[i].x, zi = points[i].z;
    var xj = points[j].x, zj = points[j].z;
    var intersect = zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  if (inside) return true;
  for (var k = 0, l = points.length - 1; k < points.length; l = k++) {
    if (distPointToSegment(px, pz, points[l].x, points[l].z, points[k].x, points[k].z) < buffer) return true;
  }
  return false;
}
function isCollidingWithBuilding(x, y, z) {
  for (var i = 0; i < buildings.length; i++) {
    var b = buildings[i];
    if (y > b.height + COLLISION_BUFFER) continue;
    if (x < b.minX - COLLISION_BUFFER || x > b.maxX + COLLISION_BUFFER) continue;
    if (z < b.minZ - COLLISION_BUFFER || z > b.maxZ + COLLISION_BUFFER) continue;
    if (pointNearPolygon(x, z, b.points, COLLISION_BUFFER)) return true;
  }
  return false;
}

function updateFlight(dt) {
  var kbYaw = (keys["ArrowLeft"] || keys["KeyA"] ? 1 : 0) - (keys["ArrowRight"] || keys["KeyD"] ? 1 : 0);
  var kbPitch = (keys["ArrowUp"] || keys["KeyW"] ? 1 : 0) - (keys["ArrowDown"] || keys["KeyS"] ? 1 : 0);
  var yawInput = Math.max(-1, Math.min(1, kbYaw + -joystickVec.x));
  var throttlePitchInput = Math.max(-1, Math.min(1, kbPitch + -joystickVec.y));
  var wantsBoost = boosting || !!keys["Space"];
  var vertSpeed = 0;

  if (grounded) {
    // ground handling: steer, throttle up/down with the pitch keys, lift off past takeoff speed.
    // The boost control (Space / boost button) also throttles up on the ground -- it's the
    // one control every input scheme (keyboard, joystick, mobile boost button) shares, and the
    // boost button's "up arrow" look makes it the natural thing to hold for takeoff on touch.
    var throttleUp = throttlePitchInput > 0 || wantsBoost;
    yaw += yawInput * (TURN_RATE_BASE * 0.5) * dt;
    var accel = throttleUp ? stats.groundAccel : throttlePitchInput < 0 ? -stats.groundAccel * 1.4 : -4;
    speed = Math.max(0, Math.min(stats.boostSpeed, speed + accel * dt));
    pitch = 0;
    roll = 0;

    plane.rotation.order = "YXZ";
    plane.rotation.set(0, yaw, 0);
    forwardVec.set(0, 0, -1).applyEuler(plane.rotation);
    plane.position.addScaledVector(forwardVec, speed * dt);
    plane.position.y = GROUND_Y;

    if (speed >= stats.takeoffSpeed && throttleUp) {
      grounded = false;
      airborneElapsed = 0;
      pitch = 0.18;
      statusEl.textContent = "AIRBORNE";
      showToast("Wheels up!");
    }
  } else {
    airborneElapsed += dt;
    yaw += yawInput * stats.turnRate * dt;
    pitch += throttlePitchInput * stats.pitchRate * dt;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    roll += (yawInput * -0.7 - roll) * 4 * dt;

    var targetSpeed = wantsBoost ? stats.boostSpeed : stats.cruiseSpeed;
    speed += (targetSpeed - speed) * Math.min(1, dt * 2);

    plane.rotation.order = "YXZ";
    plane.rotation.set(pitch, yaw, roll);
    forwardVec.set(0, 0, -1).applyEuler(plane.rotation);
    plane.position.addScaledVector(forwardVec, speed * dt);
    vertSpeed = forwardVec.y * speed;

    if (plane.position.y > CEILING_Y) plane.position.y = CEILING_Y;
  }

  var half = TOWN_HALF + 30;
  plane.position.x = Math.max(-half, Math.min(half, plane.position.x));
  plane.position.z = Math.max(-half, Math.min(half, plane.position.z));

  if (isCollidingWithBuilding(plane.position.x, plane.position.y, plane.position.z)) {
    return crash("Crashed!");
  }

  // You can land anywhere, not just the runway — only speed/attitude/sink-rate need to be safe.
  // Skip this while still climbing away from a takeoff so liftoff doesn't immediately re-land it.
  if (!grounded && plane.position.y <= GROUND_MIN_Y && vertSpeed <= 3) {
    var safeSpeed = speed <= stats.cruiseSpeed * 1.15;
    var safeAttitude = Math.abs(pitch) < LANDING_MAX_TILT && Math.abs(roll) < LANDING_MAX_TILT;
    var safeSink = vertSpeed > -16;

    if (safeSpeed && safeAttitude && safeSink) {
      grounded = true;
      plane.position.y = GROUND_Y;
      pitch = 0;
      roll = 0;
      statusEl.textContent = "LANDED";
      if (airborneElapsed > 1) {
        score += 5;
        scoreEl.textContent = "Score: " + score;
        showToast("Landed! +5");
      } else {
        showToast("Landed!");
      }
    } else {
      return crash("Crashed!");
    }
  }

  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    tmpVec.subVectors(plane.position, ring.mesh.position);
    var along = tmpVec.dot(ring.normal);
    if (Math.abs(along) > 4) continue;
    var radial = tmpVec.length();
    if (radial < RING_RADIUS - 1.5) {
      score += 1;
      scoreEl.textContent = "Score: " + score;
      placeRing(ring);
    }
  }

  altEl.textContent = "ALT " + Math.round(plane.position.y);
  spdEl.textContent = "SPD " + Math.round(speed);

  var behind = forwardVec.clone().multiplyScalar(-14);
  var desiredCamPos = plane.position.clone().add(behind).add(new THREE.Vector3(0, 5, 0));
  camPos.lerp(desiredCamPos, Math.min(1, dt * 4));
  camLook.lerp(plane.position, Math.min(1, dt * 6));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

function crash(reason) {
  state = "over";
  if (score > best) {
    best = score;
    localStorage.setItem(STORAGE_KEY, String(best));
    bestEl.textContent = "Best: " + best;
  }
  overlayMsg.innerHTML = reason + " Score: " + score + "<br />Best: " + best;
  startBtn.textContent = "↻ Retry";
  overlay.style.display = "flex";
  loadingMsg.style.display = "none";
  readyPanel.style.display = "flex";
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
var lastTime = null;
function loop(ts) {
  if (lastTime === null) lastTime = ts;
  var dt = Math.min(0.05, (ts - lastTime) / 1000);
  lastTime = ts;

  if (state === "playing") {
    updateFlight(dt);
  } else if (worldReady) {
    camera.position.set(RUNWAY.minX - 30, 22, 40);
    camera.lookAt(plane.position.x, 6, plane.position.z);
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) toastEl.classList.remove("show");
  }

  for (var i = 0; i < rings.length; i++) {
    rings[i].mesh.rotation.z += dt * 0.6;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

function startGame() {
  if (!worldReady) return;
  resetFlight();
  state = "playing";
  overlay.style.display = "none";
}
startBtn.addEventListener("click", function (e) {
  e.stopPropagation();
  startGame();
});

resize();
requestAnimationFrame(loop);
