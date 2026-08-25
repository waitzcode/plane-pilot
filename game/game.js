// Sky Runner 3D — self-contained arcade flying game over real-world city/airport layouts
// (pulled from OpenStreetMap via the free Overpass API), with taxi/takeoff/landing physics,
// a destination picker, and a plane-select screen. No dependency on the parent site; only
// talks to the DOM inside game/index.html. Uses Three.js (loaded via importmap in index.html).
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
var destSelectEl = document.getElementById("destination-select");
var destLoadingEl = document.getElementById("dest-loading");
var planeSelectEl = document.getElementById("plane-select");
var startBtn = document.getElementById("start-btn");
var toastEl = document.getElementById("toast");
var flashEl = document.getElementById("flash");
var joystickBase = document.getElementById("joystick-base");
var joystickKnob = document.getElementById("joystick-knob");
var boostBtn = document.getElementById("boost-btn");

var STORAGE_KEY = "sky-runner-3d-best";
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
scene.fog = new THREE.Fog(SKY_COLOR, 300, 1700);

var camera = new THREE.PerspectiveCamera(72, 1, 0.5, 4000);

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
// Destinations — each a real place, fetched live from OpenStreetMap. New York has no
// real runway in its downtown bbox, so it keeps a synthetic strip; Tokyo/LA use each
// airport's actual real runway geometry (position, heading, length, width) from OSM.
// ---------------------------------------------------------------------------
var DESTINATIONS = [
  {
    id: "nyc",
    name: "New York",
    subtitle: "Manhattan skyline",
    bbox: { south: 40.7385, west: -73.995, north: 40.7465, east: -73.9845 },
    worldHalf: 460,
  },
  {
    id: "hnd",
    name: "Tokyo",
    subtitle: "Haneda Airport",
    bbox: { south: 35.539316888250085, west: 139.7663591592919, north: 35.55728311174991, east: 139.7884408407081 },
    worldHalf: 1050,
  },
  {
    id: "lax",
    name: "Los Angeles",
    subtitle: "LAX Airport",
    bbox: { south: 33.926516888250084, west: -118.41172737605143, north: 33.94448311174991, east: -118.39007262394856 },
    worldHalf: 1050,
  },
];
var CACHE_PREFIX = "sky-runner-3d-osm-cache-v2-";

var RENDER_WORLD_HALF = 1100; // fixed, generous ground/fog size covering every destination
var EARTH_R = 6371000;
var CEILING_Y = 340;
var GROUND_MIN_Y = 3;

var CENTER_LAT = 0, CENTER_LON = 0; // set per destination before projecting
var WORLD_HALF = 460; // set per destination — used for building filtering, ring bounds, world clamp

function project(lat, lon) {
  var x = (lon - CENTER_LON) * Math.cos((CENTER_LAT * Math.PI) / 180) * (Math.PI / 180) * EARTH_R;
  var z = (CENTER_LAT - lat) * (Math.PI / 180) * EARTH_R;
  return { x: x, z: z };
}

// ---------------------------------------------------------------------------
// Runway — an oriented rectangle (center, heading, length, width) rather than a fixed
// axis-aligned box, so a real runway's actual position/orientation can be used directly.
// ---------------------------------------------------------------------------
var RUNWAY_LENGTH_CAP = 520; // real runways run 2.5-3.5km; capped to an arcade-appropriate strip
var RUNWAY = null; // { cx, cz, dirX, dirZ, normX, normZ, halfLength, halfWidth, meshHeadingY }

function makeSyntheticRunway() {
  return { cx: 0, cz: 0, dirX: 1, dirZ: 0, normX: 0, normZ: 1, halfLength: 110, halfWidth: 15, meshHeadingY: 0 };
}

function runwayFromOsmWay(way) {
  var g = way.geometry;
  var a = project(g[0].lat, g[0].lon);
  var b = project(g[g.length - 1].lat, g[g.length - 1].lon);
  var dx = b.x - a.x, dz = b.z - a.z;
  var realLength = Math.sqrt(dx * dx + dz * dz);
  if (realLength < 1) return null;
  var dirX = dx / realLength, dirZ = dz / realLength;
  var width = parseFloat(way.tags && way.tags.width);
  if (!isFinite(width)) width = 45;
  width = Math.max(20, Math.min(70, width));
  var halfLength = Math.min(realLength, RUNWAY_LENGTH_CAP) / 2;
  return {
    cx: (a.x + b.x) / 2,
    cz: (a.z + b.z) / 2,
    dirX: dirX,
    dirZ: dirZ,
    normX: -dirZ,
    normZ: dirX,
    halfLength: halfLength,
    halfWidth: width / 2,
    meshHeadingY: Math.atan2(-dirZ, dirX),
  };
}

function pickPrimaryRunway(runwayElements) {
  var best = null, bestLen = -1;
  for (var i = 0; i < runwayElements.length; i++) {
    var way = runwayElements[i];
    if (!way.geometry || way.geometry.length < 2) continue;
    var g = way.geometry;
    var a = project(g[0].lat, g[0].lon);
    var b = project(g[g.length - 1].lat, g[g.length - 1].lon);
    var len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > bestLen) {
      bestLen = len;
      best = way;
    }
  }
  return best ? runwayFromOsmWay(best) : null;
}

function overlapsRunway(minX, maxX, minZ, maxZ) {
  var corners = [
    [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ],
  ];
  for (var i = 0; i < 4; i++) {
    var dx = corners[i][0] - RUNWAY.cx, dz = corners[i][1] - RUNWAY.cz;
    var along = dx * RUNWAY.dirX + dz * RUNWAY.dirZ;
    var across = dx * RUNWAY.normX + dz * RUNWAY.normZ;
    if (Math.abs(along) < RUNWAY.halfLength + 12 && Math.abs(across) < RUNWAY.halfWidth + 12) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ground — one fixed, generously sized plane; never rebuilt between destinations.
// ---------------------------------------------------------------------------
function makeGroundTexture() {
  var size = 512;
  var c = document.createElement("canvas");
  c.width = c.height = size;
  var g = c.getContext("2d");
  g.fillStyle = "#4a4d52";
  g.fillRect(0, 0, size, size);
  for (var i = 0; i < 2200; i++) {
    var shade = 60 + Math.floor(Math.random() * 40);
    g.fillStyle = "rgba(" + shade + "," + shade + "," + (shade + 4) + "," + (0.15 + Math.random() * 0.2) + ")";
    var px = Math.random() * size, py = Math.random() * size;
    g.fillRect(px, py, 1.4, 1.4);
  }
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
  tex.repeat.set(RENDER_WORLD_HALF / 30, RENDER_WORLD_HALF / 30);
  return tex;
}

var ground = new THREE.Mesh(
  new THREE.PlaneGeometry(RENDER_WORLD_HALF * 2.4, RENDER_WORLD_HALF * 2.4),
  new THREE.MeshStandardMaterial({ map: makeGroundTexture(), roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// ---------------------------------------------------------------------------
// Runway mesh + edge lights — rebuilt (disposed and recreated) per destination, since
// each destination's runway has a different position, orientation, length and width.
// ---------------------------------------------------------------------------
function makeRunwayTexture(lengthM) {
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

var runwayMesh = null;
var edgeLightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xfff2cc, emissiveIntensity: 0.6 });
var edgeLightsGroup = new THREE.Group();
scene.add(edgeLightsGroup);

function rebuildRunwayMesh() {
  if (runwayMesh) {
    scene.remove(runwayMesh);
    runwayMesh.geometry.dispose();
    runwayMesh.material.map.dispose();
    runwayMesh.material.dispose();
  }
  var length = RUNWAY.halfLength * 2, width = RUNWAY.halfWidth * 2;
  runwayMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshStandardMaterial({ map: makeRunwayTexture(length), roughness: 0.9 })
  );
  var tiltQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  var headingQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), RUNWAY.meshHeadingY);
  runwayMesh.quaternion.copy(headingQuat).multiply(tiltQuat);
  runwayMesh.position.set(RUNWAY.cx, 0.06, RUNWAY.cz);
  scene.add(runwayMesh);

  while (edgeLightsGroup.children.length) {
    var m = edgeLightsGroup.children[0];
    edgeLightsGroup.remove(m);
    m.geometry.dispose();
  }
  for (var along = -RUNWAY.halfLength + 6; along <= RUNWAY.halfLength - 6; along += 18) {
    [-RUNWAY.halfWidth - 2, RUNWAY.halfWidth + 2].forEach(function (across) {
      var lx = RUNWAY.cx + RUNWAY.dirX * along + RUNWAY.normX * across;
      var lz = RUNWAY.cz + RUNWAY.dirZ * along + RUNWAY.normZ * across;
      var light = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), edgeLightMat);
      light.position.set(lx, 0.6, lz);
      edgeLightsGroup.add(light);
    });
  }
}

// ---------------------------------------------------------------------------
// Real buildings via OpenStreetMap Overpass API, with a procedural fallback if the
// fetch fails (offline, blocked, rate-limited, etc).
// ---------------------------------------------------------------------------
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

var buildings = []; // { points:[{x,z}...], minX,maxX,minZ,maxZ, height }
var buildingsGroup = new THREE.Group();
scene.add(buildingsGroup);

function clearWorld() {
  while (buildingsGroup.children.length) {
    var mesh = buildingsGroup.children[0];
    buildingsGroup.remove(mesh);
    mesh.geometry.dispose();
  }
  buildings.length = 0;
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
  if (Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minZ), Math.abs(maxZ)) > WORLD_HALF) return;

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
    if (!tags.building || !geom || geom.length < 3) continue;

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
  var cells = Math.floor((WORLD_HALF * 2) / BLOCK);
  var start = -WORLD_HALF + BLOCK / 2;
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

function fetchDestinationData(dest) {
  var b = dest.bbox;
  var query =
    "[out:json][timeout:25];(way[\"building\"](" + b.south + "," + b.west + "," + b.north + "," + b.east + ");" +
    "way[\"aeroway\"=\"runway\"](" + b.south + "," + b.west + "," + b.north + "," + b.east + "););out body geom;";
  var cacheKey = CACHE_PREFIX + dest.id;
  var cached = null;
  try {
    var raw = localStorage.getItem(cacheKey);
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
        localStorage.setItem(cacheKey, JSON.stringify({ elements: data.elements }));
      } catch (e) {
        /* storage full/unavailable — fine, just skip caching */
      }
      return data.elements;
    });
}

var worldReady = false;
var currentDestIndex = 0;
var loadGeneration = 0;

function loadDestination(index) {
  var dest = DESTINATIONS[index];
  var myGeneration = ++loadGeneration;
  currentDestIndex = index;
  worldReady = false;

  var cards = destSelectEl.querySelectorAll(".dest-card");
  for (var c = 0; c < cards.length; c++) {
    cards[c].classList.toggle("selected", c === index);
    cards[c].disabled = true;
  }
  destLoadingEl.textContent = "Loading " + dest.name + " map data…";
  startBtn.disabled = true;

  CENTER_LAT = (dest.bbox.south + dest.bbox.north) / 2;
  CENTER_LON = (dest.bbox.west + dest.bbox.east) / 2;
  WORLD_HALF = dest.worldHalf;

  fetchDestinationData(dest)
    .then(function (elements) {
      if (myGeneration !== loadGeneration) return;
      // RUNWAY must be resolved before buildings are built: addBuildingFromFootprint
      // excludes footprints overlapping it, so building the list first (with RUNWAY still
      // stale/null) would either crash on the very first load or exclude against the wrong
      // strip on a destination switch.
      var runwayEls = elements.filter(function (e) { return e.tags && e.tags.aeroway === "runway"; });
      RUNWAY = pickPrimaryRunway(runwayEls) || makeSyntheticRunway();
      clearWorld();
      var buildingCount = buildFromOsmElements(elements);
      if (buildingCount === 0) throw new Error("no buildings returned");
    })
    .catch(function () {
      if (myGeneration !== loadGeneration) return;
      clearWorld();
      RUNWAY = makeSyntheticRunway();
      buildFallbackTown();
    })
    .then(function () {
      if (myGeneration !== loadGeneration) return;
      rebuildRunwayMesh();
      worldReady = true;
      destLoadingEl.textContent = "";
      for (var c2 = 0; c2 < cards.length; c2++) cards[c2].disabled = false;
      startBtn.disabled = false;
      loadingMsg.style.display = "none";
      readyPanel.style.display = "flex";
      resetFlight();
    });
}

function selectDestination(index) {
  if (index === currentDestIndex && worldReady) return;
  loadDestination(index);
}

DESTINATIONS.forEach(function (dest, index) {
  var card = document.createElement("button");
  card.type = "button";
  card.className = "dest-card" + (index === 0 ? " selected" : "");
  card.innerHTML =
    '<span class="dest-name">' + dest.name + "</span>" +
    '<span class="dest-stats">' + dest.subtitle + "</span>";
  card.addEventListener("click", function () { selectDestination(index); });
  destSelectEl.appendChild(card);
});

// ---------------------------------------------------------------------------
// Plane presets + model builder — tuned fast, arcade-style.
// ---------------------------------------------------------------------------
var PLANE_PRESETS = [
  {
    name: "Cruiser",
    stats: "Balanced • easy to fly",
    bodyColor: 0x00f0ff,
    accentColor: 0xff2e88,
    scale: 1,
    cruiseSpeed: 85,
    boostSpeed: 155,
    turnRate: 1.7,
    pitchRate: 1.15,
    takeoffSpeed: 55,
    groundAccel: 38,
  },
  {
    name: "Falcon",
    stats: "Fast • less nimble",
    bodyColor: 0xff5a3c,
    accentColor: 0xffd400,
    scale: 0.88,
    cruiseSpeed: 115,
    boostSpeed: 195,
    turnRate: 1.35,
    pitchRate: 1,
    takeoffSpeed: 75,
    groundAccel: 50,
  },
  {
    name: "Nimbus",
    stats: "Agile • easy landings",
    bodyColor: 0x7bff5a,
    accentColor: 0xffd400,
    scale: 1.18,
    cruiseSpeed: 65,
    boostSpeed: 115,
    turnRate: 2.2,
    pitchRate: 1.55,
    takeoffSpeed: 40,
    groundAccel: 30,
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
  scene.add(plane);
  if (RUNWAY) placeOnRunwayStart(plane);
  var cards = planeSelectEl.querySelectorAll(".plane-card");
  for (var i = 0; i < cards.length; i++) {
    cards[i].classList.toggle("selected", i === index);
  }
}

function placeOnRunwayStart(target) {
  var inset = Math.min(30, RUNWAY.halfLength * 0.4);
  var startAlong = -RUNWAY.halfLength + inset;
  target.position.set(RUNWAY.cx + RUNWAY.dirX * startAlong, 0.9, RUNWAY.cz + RUNWAY.dirZ * startAlong);
  target.rotation.set(0, Math.atan2(-RUNWAY.dirX, -RUNWAY.dirZ), 0);
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
  var x = (Math.random() * 2 - 1) * (WORLD_HALF - 40);
  var z = (Math.random() * 2 - 1) * (WORLD_HALF - 40);
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
var MAX_PITCH = Math.PI / 3;
var GROUND_Y = 0.9;
var LANDING_MAX_TILT = 0.35;

var stats; // active plane's tuning, set on start
var airborneElapsed = 0; // guards against rapidly re-triggering the landing bonus by skipping/bouncing

// ---------------------------------------------------------------------------
// Crash effects — fire burst, smoke, flying debris, screen flash + camera shake.
// ---------------------------------------------------------------------------
function makeParticleTexture() {
  var size = 64;
  var c = document.createElement("canvas");
  c.width = c.height = size;
  var g = c.getContext("2d");
  var grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,196,80,0.9)");
  grad.addColorStop(1, "rgba(255,80,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
var particleTexture = makeParticleTexture();

var fireBursts = []; // { points, velocities, age, maxAge }
var smokePuffs = []; // { mesh, vel, age, maxAge }
var debrisPieces = []; // { mesh, vel, angVel, age, maxAge }

function clearCrashEffects() {
  fireBursts.forEach(function (fb) {
    scene.remove(fb.points);
    fb.points.geometry.dispose();
    fb.points.material.dispose();
  });
  fireBursts.length = 0;
  smokePuffs.forEach(function (sp) {
    scene.remove(sp.mesh);
    sp.mesh.geometry.dispose();
    sp.mesh.material.dispose();
  });
  smokePuffs.length = 0;
  debrisPieces.forEach(function (db) {
    scene.remove(db.mesh);
    db.mesh.geometry.dispose();
    db.mesh.material.dispose();
  });
  debrisPieces.length = 0;
}

var crashCamTarget = new THREE.Vector3();
var crashCamTimer = 0;
var shakeTimer = 0;
var SHAKE_DURATION = 0.5;

function triggerCrashEffect(position) {
  var count = 60;
  var positions = new Float32Array(count * 3);
  var velocities = [];
  for (var i = 0; i < count; i++) {
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y + 0.5;
    positions[i * 3 + 2] = position.z;
    var theta = Math.random() * Math.PI * 2;
    var phi = Math.random() * Math.PI - Math.PI / 2;
    var burstSpeed = 6 + Math.random() * 14;
    velocities.push(
      new THREE.Vector3(
        Math.cos(theta) * Math.cos(phi) * burstSpeed,
        Math.abs(Math.sin(phi)) * burstSpeed + 4,
        Math.sin(theta) * Math.cos(phi) * burstSpeed
      )
    );
  }
  var geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  var mat = new THREE.PointsMaterial({
    size: 3.2,
    map: particleTexture,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  var points = new THREE.Points(geom, mat);
  scene.add(points);
  fireBursts.push({ points: points, velocities: velocities, age: 0, maxAge: 1.1 });

  for (var s = 0; s < 5; s++) {
    var smokeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.4 + Math.random(), 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0.65 })
    );
    smokeMesh.position.copy(position).add(new THREE.Vector3((Math.random() - 0.5) * 3, 0.5 + Math.random() * 2, (Math.random() - 0.5) * 3));
    scene.add(smokeMesh);
    smokePuffs.push({
      mesh: smokeMesh,
      vel: new THREE.Vector3((Math.random() - 0.5) * 3, 3 + Math.random() * 3, (Math.random() - 0.5) * 3),
      age: 0,
      maxAge: 1.8,
    });
  }

  var debrisColors = [0x1c1f24, 0x3a3d42, 0xb8321f];
  for (var d = 0; d < 7; d++) {
    var piece = new THREE.Mesh(
      new THREE.BoxGeometry(0.4 + Math.random() * 0.6, 0.3 + Math.random() * 0.4, 0.4 + Math.random() * 0.6),
      new THREE.MeshStandardMaterial({ color: debrisColors[d % debrisColors.length], roughness: 0.75 })
    );
    piece.position.copy(position);
    scene.add(piece);
    var debrisTheta = Math.random() * Math.PI * 2;
    var debrisSpeed = 5 + Math.random() * 10;
    debrisPieces.push({
      mesh: piece,
      vel: new THREE.Vector3(Math.cos(debrisTheta) * debrisSpeed, 6 + Math.random() * 8, Math.sin(debrisTheta) * debrisSpeed),
      angVel: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10),
      age: 0,
      maxAge: 2.2,
    });
  }

  flashEl.style.transition = "none";
  flashEl.style.opacity = "1";
  requestAnimationFrame(function () {
    flashEl.style.transition = "opacity 0.5s ease";
    flashEl.style.opacity = "0";
  });

  crashCamTarget.copy(position);
  crashCamTimer = 1.4;
  shakeTimer = SHAKE_DURATION;
}

function updateCrashEffects(dt) {
  for (var i = fireBursts.length - 1; i >= 0; i--) {
    var fb = fireBursts[i];
    fb.age += dt;
    var posAttr = fb.points.geometry.attributes.position;
    for (var j = 0; j < fb.velocities.length; j++) {
      var v = fb.velocities[j];
      v.y -= 18 * dt;
      posAttr.array[j * 3] += v.x * dt;
      posAttr.array[j * 3 + 1] += v.y * dt;
      posAttr.array[j * 3 + 2] += v.z * dt;
    }
    posAttr.needsUpdate = true;
    fb.points.material.opacity = Math.max(0, 1 - fb.age / fb.maxAge);
    if (fb.age >= fb.maxAge) {
      scene.remove(fb.points);
      fb.points.geometry.dispose();
      fb.points.material.dispose();
      fireBursts.splice(i, 1);
    }
  }

  for (var s = smokePuffs.length - 1; s >= 0; s--) {
    var sp = smokePuffs[s];
    sp.age += dt;
    sp.vel.multiplyScalar(0.97);
    sp.mesh.position.addScaledVector(sp.vel, dt);
    sp.mesh.scale.setScalar(1 + sp.age * 1.6);
    sp.mesh.material.opacity = Math.max(0, 0.65 * (1 - sp.age / sp.maxAge));
    if (sp.age >= sp.maxAge) {
      scene.remove(sp.mesh);
      sp.mesh.geometry.dispose();
      sp.mesh.material.dispose();
      smokePuffs.splice(s, 1);
    }
  }

  for (var d = debrisPieces.length - 1; d >= 0; d--) {
    var db = debrisPieces[d];
    db.age += dt;
    db.vel.y -= 22 * dt;
    db.mesh.position.addScaledVector(db.vel, dt);
    db.mesh.rotation.x += db.angVel.x * dt;
    db.mesh.rotation.y += db.angVel.y * dt;
    db.mesh.rotation.z += db.angVel.z * dt;
    if (db.mesh.position.y <= 0.2) {
      db.mesh.position.y = 0.2;
      db.vel.set(0, 0, 0);
    }
    if (db.age >= db.maxAge) {
      scene.remove(db.mesh);
      db.mesh.geometry.dispose();
      db.mesh.material.dispose();
      debrisPieces.splice(d, 1);
    }
  }
}

function resetFlight() {
  stats = PLANE_PRESETS[selectedPresetIndex];
  placeOnRunwayStart(plane);
  plane.visible = true;
  yaw = plane.rotation.y;
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
  clearCrashEffects();
  crashCamTimer = 0;
  shakeTimer = 0;
}

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

    // You can land anywhere, not just the runway — only speed/attitude/sink-rate need to be
    // safe. This must live here, inside the airborne branch, using THIS frame's freshly
    // computed vertSpeed: checking it after the grounded/airborne if-else (as a shared
    // `!grounded` check) used to also fire on the very same frame a takeoff just happened,
    // reading vertSpeed's stale initial value of 0 (which reads as "safe") and immediately
    // snapping the plane back down — so it could never actually leave the ground.
    if (plane.position.y <= GROUND_MIN_Y && vertSpeed <= 3) {
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
  }

  var half = WORLD_HALF + 30;
  plane.position.x = Math.max(-half, Math.min(half, plane.position.x));
  plane.position.z = Math.max(-half, Math.min(half, plane.position.z));

  if (isCollidingWithBuilding(plane.position.x, plane.position.y, plane.position.z)) {
    return crash("Crashed!");
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

  var behind = forwardVec.clone().multiplyScalar(-18);
  var desiredCamPos = plane.position.clone().add(behind).add(new THREE.Vector3(0, 6, 0));
  camPos.lerp(desiredCamPos, Math.min(1, dt * 5));
  camLook.lerp(plane.position, Math.min(1, dt * 7));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

function crash(reason) {
  state = "over";
  document.body.classList.remove("playing");
  triggerCrashEffect(plane.position);
  plane.visible = false;
  if (score > best) {
    best = score;
    localStorage.setItem(STORAGE_KEY, String(best));
    bestEl.textContent = "Best: " + best;
  }
  overlayMsg.innerHTML = reason + " Score: " + score + "<br />Best: " + best;
  startBtn.textContent = "↻ Retry";
  loadingMsg.style.display = "none";
  readyPanel.style.display = "flex";
  // hold off on the game-over menu so the crash is actually visible first
  setTimeout(function () {
    overlay.style.display = "flex";
  }, 900);
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
  } else if (crashCamTimer > 0) {
    crashCamTimer -= dt;
    var shakeX = 0, shakeY = 0, shakeZ = 0;
    if (shakeTimer > 0) {
      shakeTimer -= dt;
      var shakeMag = 1.6 * Math.max(0, shakeTimer / SHAKE_DURATION);
      shakeX = (Math.random() - 0.5) * shakeMag;
      shakeY = (Math.random() - 0.5) * shakeMag;
      shakeZ = (Math.random() - 0.5) * shakeMag;
    }
    camera.position.set(crashCamTarget.x - 14 + shakeX, crashCamTarget.y + 8 + shakeY, crashCamTarget.z + 14 + shakeZ);
    camera.lookAt(crashCamTarget.x, crashCamTarget.y + 1, crashCamTarget.z);
  } else if (worldReady && RUNWAY) {
    camera.position.set(RUNWAY.cx - RUNWAY.dirX * (RUNWAY.halfLength + 30), 22, RUNWAY.cz - RUNWAY.dirZ * (RUNWAY.halfLength + 30));
    camera.lookAt(plane.position.x, 6, plane.position.z);
  }

  updateCrashEffects(dt);

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
  document.body.classList.add("playing");
}
startBtn.addEventListener("click", function (e) {
  e.stopPropagation();
  startGame();
});

resize();
loadDestination(0);
requestAnimationFrame(loop);
