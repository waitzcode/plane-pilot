// Sky Runner 3D — self-contained arcade flying game across real-world cities/airports
// (pulled from OpenStreetMap via the free Overpass API). All cities share one always-loaded
// world so you can fly seamlessly between them over open ocean, rather than teleporting
// through a menu. Real-world distances between cities are heavily compressed (an actual
// crossing is thousands of km — flying that at any playable speed would take hours), but
// each city's own layout is the real, undistorted thing. No dependency on the parent site;
// only talks to the DOM inside game/index.html. Uses Three.js (via importmap in index.html).
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
var hdgEl = document.getElementById("hdg");
var vsEl = document.getElementById("vs");
var windEl = document.getElementById("wind");
var stallWarningEl = document.getElementById("stall-warning");
var gearStatusEl = document.getElementById("gear-status");
var flapsStatusEl = document.getElementById("flaps-status");
var throttleStatusEl = document.getElementById("throttle-status");
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
var minimapCanvas = document.getElementById("minimap");
var minimapCtx = minimapCanvas.getContext("2d");
var panelCanvas = document.getElementById("instrument-panel");
var panelCtx = panelCanvas.getContext("2d");
var joystickBase = document.getElementById("joystick-base");
var joystickKnob = document.getElementById("joystick-knob");
var boostBtn = document.getElementById("boost-btn");
var throttleDownBtn = document.getElementById("throttle-down-btn");

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
scene.fog = new THREE.Fog(SKY_COLOR, 350, 2600);

var camera = new THREE.PerspectiveCamera(72, 1, 0.5, 6000);

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
// Cities — each a real place, fetched live from OpenStreetMap, positioned at a
// compressed offset in one shared world so they can all be flown between over open
// ocean. Tokyo/LA use each airport's real runway; New York/Paris have no real runway
// in their downtown bbox, so they keep a synthetic strip.
// ---------------------------------------------------------------------------
var CITIES = [
  {
    id: "nyc", name: "New York", code: "NY", subtitle: "Manhattan skyline",
    bbox: { south: 40.7385, west: -73.995, north: 40.7465, east: -73.9845 },
    worldHalf: 460,
    worldOffset: { x: 0, z: 0 },
  },
  {
    id: "hnd", name: "Tokyo", code: "TK", subtitle: "Haneda Airport",
    bbox: { south: 35.539316888250085, west: 139.7663591592919, north: 35.55728311174991, east: 139.7884408407081 },
    worldHalf: 1050,
    worldOffset: { x: -22000, z: -2500 },
  },
  {
    id: "lax", name: "Los Angeles", code: "LA", subtitle: "LAX Airport",
    bbox: { south: 33.926516888250084, west: -118.41172737605143, north: 33.94448311174991, east: -118.39007262394856 },
    worldHalf: 1050,
    worldOffset: { x: -11000, z: 2500 },
  },
  {
    id: "cdg", name: "Paris", code: "PA", subtitle: "Eiffel Tower",
    bbox: { south: 48.85195759971254, west: 2.2883561026430046, north: 48.86004240028746, east: 2.300643897356996 },
    worldHalf: 460,
    worldOffset: { x: 12000, z: -3000 },
  },
];
var CACHE_PREFIX = "sky-runner-3d-osm-cache-v3-";
var EARTH_R = 6371000;
var CEILING_Y = 340;
var GROUND_MIN_Y = 3;
var MPS_TO_KNOTS = 1.9438;
var M_TO_FEET = 3.28084;
var LAND_MARGIN = 60; // how far past a city's worldHalf still counts as "land" for landing

CITIES.forEach(function (city) {
  city.centerLat = (city.bbox.south + city.bbox.north) / 2;
  city.centerLon = (city.bbox.west + city.bbox.east) / 2;
});

function projectForCity(city, lat, lon) {
  var x = (lon - city.centerLon) * Math.cos((city.centerLat * Math.PI) / 180) * (Math.PI / 180) * EARTH_R;
  var z = (city.centerLat - lat) * (Math.PI / 180) * EARTH_R;
  return { x: x + city.worldOffset.x, z: z + city.worldOffset.z };
}

function isOverAnyCityLand(x, z) {
  for (var i = 0; i < CITIES.length; i++) {
    var c = CITIES[i];
    var dx = x - c.worldOffset.x, dz = z - c.worldOffset.z;
    if (Math.abs(dx) <= c.worldHalf + LAND_MARGIN && Math.abs(dz) <= c.worldHalf + LAND_MARGIN) return true;
  }
  return false;
}

// World bounds — computed from every city's offset + radius, with a healthy margin of
// open ocean around the outside so cities never feel like they're right at the edge.
var WORLD_MARGIN = 4000;
var WORLD_MIN_X = Infinity, WORLD_MAX_X = -Infinity, WORLD_MIN_Z = Infinity, WORLD_MAX_Z = -Infinity;
CITIES.forEach(function (c) {
  WORLD_MIN_X = Math.min(WORLD_MIN_X, c.worldOffset.x - c.worldHalf);
  WORLD_MAX_X = Math.max(WORLD_MAX_X, c.worldOffset.x + c.worldHalf);
  WORLD_MIN_Z = Math.min(WORLD_MIN_Z, c.worldOffset.z - c.worldHalf);
  WORLD_MAX_Z = Math.max(WORLD_MAX_Z, c.worldOffset.z + c.worldHalf);
});
WORLD_MIN_X -= WORLD_MARGIN; WORLD_MAX_X += WORLD_MARGIN;
WORLD_MIN_Z -= WORLD_MARGIN; WORLD_MAX_Z += WORLD_MARGIN;

// ---------------------------------------------------------------------------
// Runway — an oriented rectangle (center, heading, length, width) so a real runway's
// actual position/orientation can be used directly instead of a fixed axis-aligned box.
// ---------------------------------------------------------------------------
// Runways are sized relative to each city's own worldHalf (rather than a fixed cap) so a
// "huge" runway still fits comfortably on that city's landmass instead of poking out over
// the ocean -- real runways at Tokyo/LA (worldHalf 1050) run long enough to hit this cap
// anyway; the synthetic strips (New York/Paris, worldHalf 460) are sized down to match.
function makeSyntheticRunway(city) {
  return {
    cx: city.worldOffset.x, cz: city.worldOffset.z,
    dirX: 1, dirZ: 0, normX: 0, normZ: 1,
    halfLength: city.worldHalf * 0.7, halfWidth: 45, meshHeadingY: 0,
  };
}

function runwayFromOsmWay(city, way) {
  var g = way.geometry;
  var a = projectForCity(city, g[0].lat, g[0].lon);
  var b = projectForCity(city, g[g.length - 1].lat, g[g.length - 1].lon);
  var dx = b.x - a.x, dz = b.z - a.z;
  var realLength = Math.sqrt(dx * dx + dz * dz);
  if (realLength < 1) return null;
  var dirX = dx / realLength, dirZ = dz / realLength;
  var width = parseFloat(way.tags && way.tags.width);
  if (!isFinite(width)) width = 45;
  width = Math.max(60, Math.min(140, width * 1.8));
  var halfLength = Math.min(realLength, city.worldHalf * 0.85) / 2;
  return {
    cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2,
    dirX: dirX, dirZ: dirZ, normX: -dirZ, normZ: dirX,
    halfLength: halfLength, halfWidth: width / 2,
    meshHeadingY: Math.atan2(-dirZ, dirX),
  };
}

function pickPrimaryRunway(city, runwayElements) {
  var best = null, bestLen = -1;
  for (var i = 0; i < runwayElements.length; i++) {
    var way = runwayElements[i];
    if (!way.geometry || way.geometry.length < 2) continue;
    var g = way.geometry;
    var a = projectForCity(city, g[0].lat, g[0].lon);
    var b = projectForCity(city, g[g.length - 1].lat, g[g.length - 1].lon);
    var len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len > bestLen) {
      bestLen = len;
      best = way;
    }
  }
  return best ? runwayFromOsmWay(city, best) : null;
}

function overlapsRunway(runway, minX, maxX, minZ, maxZ) {
  var corners = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
  for (var i = 0; i < 4; i++) {
    var dx = corners[i][0] - runway.cx, dz = corners[i][1] - runway.cz;
    var along = dx * runway.dirX + dz * runway.dirZ;
    var across = dx * runway.normX + dz * runway.normZ;
    if (Math.abs(along) < runway.halfLength + 12 && Math.abs(across) < runway.halfWidth + 12) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ocean — one big plane covering the whole world, with a slowly scrolling texture for a
// cheap animated-water feel. Each city sits on its own smaller "landmass" ground patch.
// ---------------------------------------------------------------------------
function makeOceanTexture() {
  var size = 256;
  var c = document.createElement("canvas");
  c.width = c.height = size;
  var g = c.getContext("2d");
  g.fillStyle = "#2f6f92";
  g.fillRect(0, 0, size, size);
  for (var i = 0; i < 500; i++) {
    var shade = 60 + Math.floor(Math.random() * 50);
    g.strokeStyle = "rgba(" + (shade - 20) + "," + (shade + 30) + "," + (shade + 50) + "," + (0.12 + Math.random() * 0.15) + ")";
    g.lineWidth = 1 + Math.random() * 1.5;
    var y = Math.random() * size;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(size * 0.3, y + (Math.random() - 0.5) * 14, size * 0.7, y + (Math.random() - 0.5) * 14, size, y);
    g.stroke();
  }
  var tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  var span = (WORLD_MAX_X - WORLD_MIN_X + WORLD_MAX_Z - WORLD_MIN_Z);
  tex.repeat.set(span / 80, span / 80);
  return tex;
}

var oceanSize = Math.max(WORLD_MAX_X - WORLD_MIN_X, WORLD_MAX_Z - WORLD_MIN_Z) + WORLD_MARGIN * 2;
var oceanTexture = makeOceanTexture();
var ocean = new THREE.Mesh(
  new THREE.PlaneGeometry(oceanSize, oceanSize),
  new THREE.MeshStandardMaterial({ map: oceanTexture, color: 0x3f83a6, roughness: 0.5, metalness: 0.1 })
);
ocean.position.set((WORLD_MIN_X + WORLD_MAX_X) / 2, -0.15, (WORLD_MIN_Z + WORLD_MAX_Z) / 2);
ocean.rotation.x = -Math.PI / 2;
scene.add(ocean);

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
  return tex;
}

function buildLandmass(city) {
  var tex = makeGroundTexture();
  tex.repeat.set(city.worldHalf / 30, city.worldHalf / 30);
  var mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(city.worldHalf * 2.3, city.worldHalf * 2.3),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(city.worldOffset.x, -0.02, city.worldOffset.z);
  scene.add(mesh);

  // a soft coastline ring so the landmass doesn't just end in a hard rectangular edge
  var shoreMesh = new THREE.Mesh(
    new THREE.RingGeometry(city.worldHalf * 1.02, city.worldHalf * 1.3, 48),
    new THREE.MeshStandardMaterial({ color: 0xcbb98f, roughness: 1, transparent: true, opacity: 0.5 })
  );
  shoreMesh.rotation.x = -Math.PI / 2;
  shoreMesh.position.set(city.worldOffset.x, -0.01, city.worldOffset.z);
  scene.add(shoreMesh);
}

// ---------------------------------------------------------------------------
// Runway mesh + edge lights — built once per city and kept for the whole session.
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

var edgeLightMat = new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xfff2cc, emissiveIntensity: 0.6 });

function buildRunwayMesh(runway) {
  var length = runway.halfLength * 2, width = runway.halfWidth * 2;
  var mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(length, width),
    new THREE.MeshStandardMaterial({ map: makeRunwayTexture(), roughness: 0.9 })
  );
  var tiltQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  var headingQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), runway.meshHeadingY);
  mesh.quaternion.copy(headingQuat).multiply(tiltQuat);
  mesh.position.set(runway.cx, 0.06, runway.cz);
  scene.add(mesh);

  for (var along = -runway.halfLength + 6; along <= runway.halfLength - 6; along += 18) {
    [-runway.halfWidth - 2, runway.halfWidth + 2].forEach(function (across) {
      var lx = runway.cx + runway.dirX * along + runway.normX * across;
      var lz = runway.cz + runway.dirZ * along + runway.normZ * across;
      var light = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), edgeLightMat);
      light.position.set(lx, 0.6, lz);
      scene.add(light);
    });
  }
}

// ---------------------------------------------------------------------------
// Real buildings via OpenStreetMap Overpass API, with a procedural fallback per city
// if its fetch fails (offline, blocked, rate-limited, etc). Side walls get a real-scale
// window-facade texture (built once, tiled per meter) rather than a flat solid color.
// ---------------------------------------------------------------------------
var HEIGHT_PALETTE = [
  { max: 20, color: 0x9c9184, roughness: 0.9, metalness: 0.05 },
  { max: 40, color: 0x8f97a3, roughness: 0.8, metalness: 0.1 },
  { max: 80, color: 0x7d93ab, roughness: 0.6, metalness: 0.25 },
  { max: 140, color: 0x6c86a3, roughness: 0.45, metalness: 0.4 },
  { max: 99999, color: 0x5a7396, roughness: 0.3, metalness: 0.55 },
];
function paletteForHeight(h) {
  for (var i = 0; i < HEIGHT_PALETTE.length; i++) {
    if (h <= HEIGHT_PALETTE[i].max) return HEIGHT_PALETTE[i];
  }
  return HEIGHT_PALETTE[HEIGHT_PALETTE.length - 1];
}
function colorForBuilding(tags, height) {
  if (tags && tags["building:colour"]) {
    try {
      return new THREE.Color(tags["building:colour"]).getHex();
    } catch (e) {
      /* invalid color string — fall through to the height-based palette */
    }
  }
  return paletteForHeight(height).color;
}

// A single window-facade texture, reused (tinted per building via material.color) across
// every building — a custom UV generator gives real-meter side-wall UVs so window spacing
// looks consistent regardless of a building's footprint size, and roof/floor caps sample a
// flat swatch in the texture's corner instead of a stretched/tiled window pattern.
function makeFacadeTexture() {
  var size = 64;
  var c = document.createElement("canvas");
  c.width = c.height = size;
  var g = c.getContext("2d");
  g.fillStyle = "#b9c3cc";
  g.fillRect(0, 0, size, size);
  var pad = 8;
  g.fillStyle = "#43586e";
  g.fillRect(pad, pad, size - pad * 2, size - pad * 2);
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.fillRect(pad, pad, size - pad * 2, 3);
  // flat roof/floor-cap swatch, kept in the corner well away from the window
  g.fillStyle = "#585d61";
  g.fillRect(0, 0, 4, 4);
  var tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
var facadeTexture = makeFacadeTexture();
var WINDOW_SPACING_U = 3.4; // meters per window column
var WINDOW_SPACING_V = 3.6; // meters per floor
var CAP_UV = new THREE.Vector2(0.01, 0.01); // lands inside the flat corner swatch

var facadeUVGenerator = {
  generateTopUV: function () { return [CAP_UV.clone(), CAP_UV.clone(), CAP_UV.clone()]; },
  generateBottomUV: function () { return [CAP_UV.clone(), CAP_UV.clone(), CAP_UV.clone()]; },
  generateSideWallUV: function (geometry, vertices, indexA, indexB, indexC, indexD) {
    var ax = vertices[indexA * 3], ay = vertices[indexA * 3 + 1], az = vertices[indexA * 3 + 2];
    var bx = vertices[indexB * 3], by = vertices[indexB * 3 + 1], bz = vertices[indexB * 3 + 2];
    var cz = vertices[indexC * 3 + 2];
    var dz = vertices[indexD * 3 + 2];
    var span = Math.hypot(bx - ax, by - ay);
    return [
      new THREE.Vector2(0, az / WINDOW_SPACING_V),
      new THREE.Vector2(span / WINDOW_SPACING_U, bz / WINDOW_SPACING_V),
      new THREE.Vector2(span / WINDOW_SPACING_U, cz / WINDOW_SPACING_V),
      new THREE.Vector2(0, dz / WINDOW_SPACING_V),
    ];
  },
};

var materialCache = {};
function materialFor(hexColor, roughness, metalness) {
  var key = hexColor + "|" + roughness + "|" + metalness;
  if (!materialCache[key]) {
    materialCache[key] = new THREE.MeshStandardMaterial({
      color: hexColor,
      map: facadeTexture,
      roughness: roughness,
      metalness: metalness,
    });
  }
  return materialCache[key];
}

var buildings = []; // { points:[{x,z}...], minX,maxX,minZ,maxZ, height }
var buildingsGroup = new THREE.Group();
scene.add(buildingsGroup);

function addBuildingFromFootprint(runway, points, height, colorHex, roughness, metalness) {
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
  if (overlapsRunway(runway, minX, maxX, minZ, maxZ)) return;

  var geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, UVGenerator: facadeUVGenerator });
  geom.rotateX(-Math.PI / 2);
  var mesh = new THREE.Mesh(geom, materialFor(colorHex, roughness, metalness));
  buildingsGroup.add(mesh);

  buildings.push({ points: points, minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, height: height });
}

function buildFromOsmElements(city, runway, elements) {
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

    var pts = geom.map(function (pt) { return projectForCity(city, pt.lat, pt.lon); });
    // drop the closing duplicate point OSM ways include
    if (pts.length > 1) {
      var a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < 0.001 && Math.abs(a.z - b.z) < 0.001) pts.pop();
    }
    var palette = paletteForHeight(height);
    addBuildingFromFootprint(runway, pts, height, colorForBuilding(tags, height), palette.roughness, palette.metalness);
    count++;
  }
  return count;
}

function buildFallbackTown(city, runway) {
  var BLOCK = 60;
  var half = city.worldHalf;
  var cells = Math.floor((half * 2) / BLOCK);
  var start = -half + BLOCK / 2;
  for (var ix = 0; ix < cells; ix++) {
    for (var iz = 0; iz < cells; iz++) {
      var cx = city.worldOffset.x + start + ix * BLOCK;
      var cz = city.worldOffset.z + start + iz * BLOCK;
      var footprint = 26 + Math.random() * 10;
      var height = 14 + Math.random() * 55;
      var halfFp = footprint / 2;
      var pts = [
        { x: cx - halfFp, z: cz - halfFp },
        { x: cx + halfFp, z: cz - halfFp },
        { x: cx + halfFp, z: cz + halfFp },
        { x: cx - halfFp, z: cz + halfFp },
      ];
      var palette = paletteForHeight(height);
      addBuildingFromFootprint(runway, pts, height, palette.color, palette.roughness, palette.metalness);
    }
  }
}

function fetchCityData(city) {
  var b = city.bbox;
  var query =
    "[out:json][timeout:25];(way[\"building\"](" + b.south + "," + b.west + "," + b.north + "," + b.east + ");" +
    "way[\"aeroway\"=\"runway\"](" + b.south + "," + b.west + "," + b.north + "," + b.east + "););out body geom;";
  var cacheKey = CACHE_PREFIX + city.id;
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

function loadCity(city) {
  return fetchCityData(city)
    .then(function (elements) {
      var runwayEls = elements.filter(function (e) { return e.tags && e.tags.aeroway === "runway"; });
      var runway = pickPrimaryRunway(city, runwayEls) || makeSyntheticRunway(city);
      var n = buildFromOsmElements(city, runway, elements);
      if (n === 0) throw new Error("no buildings returned");
      city.runway = runway;
    })
    .catch(function () {
      var runway = makeSyntheticRunway(city);
      buildFallbackTown(city, runway);
      city.runway = runway;
    })
    .then(function () {
      buildLandmass(city);
      buildRunwayMesh(city.runway);
    });
}

var worldReady = false;
function loadAllCities() {
  var i = 0;
  function next() {
    if (i >= CITIES.length) {
      worldReady = true;
      destLoadingEl.textContent = "";
      loadingMsg.style.display = "none";
      readyPanel.style.display = "flex";
      resetFlight();
      return;
    }
    var city = CITIES[i];
    destLoadingEl.textContent = "Loading " + city.name + " map data… (" + (i + 1) + "/" + CITIES.length + ")";
    loadingMsg.textContent = destLoadingEl.textContent;
    i++;
    loadCity(city).then(next);
  }
  next();
}

// ---------------------------------------------------------------------------
// Destination picker — instant once the world is loaded, since every city already
// exists in the scene; picking one just moves the plane/camera to that city's runway.
// ---------------------------------------------------------------------------
var currentCityIndex = 0;
function selectDestination(index) {
  currentCityIndex = index;
  var cards = destSelectEl.querySelectorAll(".dest-card");
  for (var c = 0; c < cards.length; c++) cards[c].classList.toggle("selected", c === index);
  if (worldReady) resetFlight();
}

CITIES.forEach(function (city, index) {
  var card = document.createElement("button");
  card.type = "button";
  card.className = "dest-card" + (index === 0 ? " selected" : "");
  card.innerHTML =
    '<span class="dest-name">' + city.name + "</span>" +
    '<span class="dest-stats">' + city.subtitle + "</span>";
  card.addEventListener("click", function () { selectDestination(index); });
  destSelectEl.appendChild(card);
});

// ---------------------------------------------------------------------------
// Plane presets + model builder — tuned fast, arcade-style.
// ---------------------------------------------------------------------------
var PLANE_PRESETS = [
  {
    name: "Cessna 172",
    stats: "Light aircraft • slow & easy to fly",
    type: "prop",
    bodyColor: 0xf5f2e8,
    accentColor: 0x1a5fb4,
    scale: 1,
    cruiseSpeed: 45,
    boostSpeed: 75,
    turnRate: 2.0,
    pitchRate: 1.4,
    takeoffSpeed: 28,
    groundAccel: 22,
  },
  {
    name: "Boeing 737",
    stats: "Passenger jet • heavy, sluggish turns",
    type: "jetliner",
    engines: 2,
    bodyColor: 0xf2f4f6,
    accentColor: 0x1a5fb4,
    scale: 1.35,
    cruiseSpeed: 130,
    boostSpeed: 190,
    turnRate: 0.85,
    pitchRate: 0.65,
    takeoffSpeed: 95,
    groundAccel: 32,
  },
  {
    name: "Boeing 747",
    stats: "Jumbo jet • massive, slow to turn",
    type: "jetliner",
    engines: 4,
    bodyColor: 0xf2f4f6,
    accentColor: 0xc01c28,
    scale: 1.75,
    cruiseSpeed: 125,
    boostSpeed: 180,
    turnRate: 0.65,
    pitchRate: 0.5,
    takeoffSpeed: 110,
    groundAccel: 28,
  },
  {
    name: "F-15 Eagle",
    stats: "Military jet • blistering speed & agility",
    type: "fighter",
    tails: 2,
    engines: 2,
    bodyColor: 0x7c8592,
    accentColor: 0x454c56,
    scale: 1.05,
    cruiseSpeed: 165,
    boostSpeed: 270,
    turnRate: 2.6,
    pitchRate: 2.0,
    takeoffSpeed: 70,
    groundAccel: 62,
  },
  {
    name: "F-16 Fighting Falcon",
    stats: "Military jet • smaller, even more agile",
    type: "fighter",
    tails: 1,
    engines: 1,
    bodyColor: 0xb9c0c8,
    accentColor: 0x2a3038,
    scale: 0.85,
    cruiseSpeed: 155,
    boostSpeed: 250,
    turnRate: 3.0,
    pitchRate: 2.3,
    takeoffSpeed: 60,
    groundAccel: 58,
  },
];

function buildPlaneMesh(preset) {
  var group =
    preset.type === "jetliner" ? buildJetlinerMesh(preset) :
    preset.type === "fighter" ? buildFighterMesh(preset) :
    buildPropPlaneMesh(preset);
  group.scale.setScalar(preset.scale);
  return group;
}

function buildPropPlaneMesh(preset) {
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

  // Flaps: small trailing-edge panels that pivot down when deployed (see updateFlight).
  var flapMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.5, metalness: 0.2 });
  var flapsGroup = new THREE.Group();
  [-2.6, 2.6].forEach(function (fx) {
    var pivot = new THREE.Group();
    pivot.position.set(fx, -0.1, 0.75);
    var flap = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.55), flapMat);
    flap.position.set(0, 0, 0.3);
    pivot.add(flap);
    flapsGroup.add(pivot);
  });
  group.add(flapsGroup);

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
  var gearGroup = new THREE.Group();
  [[-1.6, -1.6], [1.6, -1.6], [0, 2]].forEach(function (p) {
    var strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 6), gearMat);
    strut.position.set(p[0], -0.85, p[1]);
    gearGroup.add(strut);
    var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 8), gearMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(p[0], -1.1, p[1]);
    gearGroup.add(wheel);
  });
  group.add(gearGroup);

  group.userData.cockpitOffset = new THREE.Vector3(0, 1.05, -0.5);
  group.userData.gearGroup = gearGroup;
  group.userData.flapsGroup = flapsGroup;
  return group;
}

// Twin-engine passenger jetliner (Boeing-style): long fuselage, swept wings with
// underslung engine pods, a window stripe, and a tall single tail fin.
function buildJetlinerMesh(preset) {
  var group = new THREE.Group();
  var bodyMat = new THREE.MeshStandardMaterial({ color: preset.bodyColor, roughness: 0.35, metalness: 0.35 });
  var accentMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.4, metalness: 0.25 });
  var darkMat = new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 0.3, metalness: 0.5 });

  var fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 7.2, 4, 12), bodyMat);
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);

  var windowStripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 7.6), darkMat);
  windowStripe.position.set(1.16, 0.55, 0);
  group.add(windowStripe);
  var windowStripe2 = windowStripe.clone();
  windowStripe2.position.x = -1.16;
  group.add(windowStripe2);

  var cockpitGlass = new THREE.Mesh(
    new THREE.SphereGeometry(1.0, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2.2),
    new THREE.MeshStandardMaterial({ color: 0x0a1226, roughness: 0.15, metalness: 0.5 })
  );
  cockpitGlass.rotation.x = Math.PI / 2;
  cockpitGlass.position.set(0, 0.35, -5.1);
  group.add(cockpitGlass);

  function makeSweptWingShape(rootChord, tipChord, span, sweep) {
    var shape = new THREE.Shape();
    shape.moveTo(0, -rootChord / 2);
    shape.lineTo(span, -tipChord / 2 - sweep);
    shape.lineTo(span, tipChord / 2 - sweep);
    shape.lineTo(0, rootChord / 2);
    shape.closePath();
    return shape;
  }
  var enginesPerSide = (preset.engines || 2) / 2;
  [-1, 1].forEach(function (side) {
    var wingGeom = new THREE.ExtrudeGeometry(makeSweptWingShape(2.2, 0.9, 6.4, 2.4), { depth: 0.16, bevelEnabled: false });
    wingGeom.translate(0, 0, -0.08);
    var wing = new THREE.Mesh(wingGeom, bodyMat);
    wing.rotation.x = Math.PI / 2;
    wing.rotation.z = side < 0 ? Math.PI : 0;
    wing.position.set(side * 1.0, -0.15, 0.6);
    group.add(wing);

    // 737 = one engine per side; 747 = two, spread further out along the wing.
    var enginePositions = enginesPerSide >= 2 ? [2.6, 4.8] : [3.6];
    enginePositions.forEach(function (ex) {
      var engine = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.36, 1.7, 10), accentMat);
      engine.rotation.x = Math.PI / 2;
      engine.position.set(side * ex, -1.0, -0.3);
      group.add(engine);
    });
  });

  // The 747's signature upper-deck hump, just aft of the cockpit.
  if ((preset.engines || 2) >= 4) {
    var hump = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 2.0, 4, 10), bodyMat);
    hump.rotation.x = Math.PI / 2;
    hump.position.set(0, 1.05, -3.2);
    group.add(hump);
  }

  var tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.0, 1.7), accentMat);
  tailFin.rotation.z = -0.18;
  tailFin.position.set(0, 1.3, 5.4);
  group.add(tailFin);

  [-1, 1].forEach(function (side) {
    var stab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.9), bodyMat);
    stab.position.set(side * 1.3, 1.15, 5.6);
    stab.rotation.z = side * -0.05;
    group.add(stab);
  });

  var flapMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.5, metalness: 0.2 });
  var flapsGroup = new THREE.Group();
  [-1, 1].forEach(function (side) {
    var pivot = new THREE.Group();
    pivot.position.set(side * 4.6, -0.55, 1.9);
    var flap = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.7), flapMat);
    flap.position.set(0, 0, 0.35);
    pivot.add(flap);
    flapsGroup.add(pivot);
  });
  group.add(flapsGroup);

  var gearMat = new THREE.MeshStandardMaterial({ color: 0x111722, roughness: 0.6 });
  var gearGroup = new THREE.Group();
  [[-1.5, 0.4], [1.5, 0.4], [0, -3.4]].forEach(function (p) {
    var strut = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.9, 6), gearMat);
    strut.position.set(p[0], -1.35, p[1]);
    gearGroup.add(strut);
    var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 10), gearMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(p[0], -1.75, p[1]);
    gearGroup.add(wheel);
  });
  group.add(gearGroup);

  group.userData.cockpitOffset = new THREE.Vector3(0, 1.3, -4.8);
  group.userData.gearGroup = gearGroup;
  group.userData.flapsGroup = flapsGroup;
  return group;
}

// Twin-tail military fighter (F-15-style): sleek fuselage, swept delta wings, twin
// canted tail fins, twin engine nozzles, and a bubble canopy.
function buildFighterMesh(preset) {
  var group = new THREE.Group();
  var bodyMat = new THREE.MeshStandardMaterial({ color: preset.bodyColor, roughness: 0.5, metalness: 0.5 });
  var accentMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.4, metalness: 0.4 });
  var nozzleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.8 });

  var fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 5.0, 4, 10), bodyMat);
  fuselage.rotation.x = Math.PI / 2;
  group.add(fuselage);

  var nose = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.7, 10), bodyMat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -3.9;
  group.add(nose);

  var canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x0a1226, roughness: 0.1, metalness: 0.6 })
  );
  canopy.scale.set(1, 0.9, 1.8);
  canopy.position.set(0, 0.55, -1.6);
  group.add(canopy);

  function makeDeltaWingShape(rootChord, tipChord, span, sweep) {
    var shape = new THREE.Shape();
    shape.moveTo(0, -rootChord / 2);
    shape.lineTo(span, -tipChord / 2 - sweep);
    shape.lineTo(span, tipChord / 2 - sweep);
    shape.lineTo(0, rootChord / 2);
    shape.closePath();
    return shape;
  }
  [-1, 1].forEach(function (side) {
    var wingGeom = new THREE.ExtrudeGeometry(makeDeltaWingShape(2.6, 0.5, 4.2, 3.4), { depth: 0.12, bevelEnabled: false });
    wingGeom.translate(0, 0, -0.06);
    var wing = new THREE.Mesh(wingGeom, accentMat);
    wing.rotation.x = Math.PI / 2;
    wing.rotation.z = side < 0 ? Math.PI : 0;
    wing.position.set(side * 0.55, -0.05, 1.1);
    group.add(wing);

    var intake = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 1.6), bodyMat);
    intake.position.set(side * 0.75, -0.35, 0.2);
    group.add(intake);

    var stab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.85), bodyMat);
    stab.position.set(side * 1.15, -0.05, 3.0);
    group.add(stab);
  });

  // F-15 (twin) vs F-16 (single) engine nozzle and tail fin -- the clearest visual
  // difference between the two real jets.
  var engineCount = preset.engines || 2;
  var enginePositions = engineCount >= 2 ? [-0.5, 0.5] : [0];
  enginePositions.forEach(function (ex) {
    var nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, 0.7, 10), nozzleMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(ex, -0.1, 3.2);
    group.add(nozzle);
  });

  var tailCount = preset.tails || 2;
  if (tailCount >= 2) {
    [-1, 1].forEach(function (side) {
      var fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 1.1), accentMat);
      fin.position.set(side * 0.7, 0.75, 2.9);
      fin.rotation.z = side * 0.22;
      group.add(fin);
    });
  } else {
    var fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.7, 1.3), accentMat);
    fin.position.set(0, 0.85, 2.9);
    group.add(fin);
  }

  var flapMat = new THREE.MeshStandardMaterial({ color: preset.accentColor, roughness: 0.5, metalness: 0.3 });
  var flapsGroup = new THREE.Group();
  [-1, 1].forEach(function (side) {
    var pivot = new THREE.Group();
    pivot.position.set(side * 2.6, -0.1, 1.9);
    var flap = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.5), flapMat);
    flap.position.set(0, 0, 0.25);
    pivot.add(flap);
    flapsGroup.add(pivot);
  });
  group.add(flapsGroup);

  var gearMat = new THREE.MeshStandardMaterial({ color: 0x111722, roughness: 0.6 });
  var gearGroup = new THREE.Group();
  [[-1.0, -0.9], [1.0, -0.9], [0, 1.7]].forEach(function (p) {
    var strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), gearMat);
    strut.position.set(p[0], -0.75, p[1]);
    gearGroup.add(strut);
    var wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.22, 8), gearMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(p[0], -1.0, p[1]);
    gearGroup.add(wheel);
  });
  group.add(gearGroup);

  group.userData.cockpitOffset = new THREE.Vector3(0, 0.85, -1.4);
  group.userData.gearGroup = gearGroup;
  group.userData.flapsGroup = flapsGroup;
  return group;
}

var selectedPresetIndex = 0;
var plane = buildPlaneMesh(PLANE_PRESETS[selectedPresetIndex]);
scene.add(plane);

function placeOnRunwayStart(target, runway) {
  var inset = Math.min(30, runway.halfLength * 0.4);
  var startAlong = -runway.halfLength + inset;
  target.position.set(runway.cx + runway.dirX * startAlong, 0.9, runway.cz + runway.dirZ * startAlong);
  target.rotation.set(0, Math.atan2(-runway.dirX, -runway.dirZ), 0);
}

function selectPreset(index) {
  selectedPresetIndex = index;
  scene.remove(plane);
  plane = buildPlaneMesh(PLANE_PRESETS[index]);
  scene.add(plane);
  var city = CITIES[currentCityIndex];
  if (city.runway) placeOnRunwayStart(plane, city.runway);
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

// third-person chase camera state (smoothed)
var camPos = new THREE.Vector3();
var camLook = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Rings — collectible checkpoints, scattered across the whole world (including over
// open water) to encourage flying between cities, not just around one.
// ---------------------------------------------------------------------------
var RING_COUNT = 18;
var RING_RADIUS = 9;
var rings = [];
var ringsGroup = new THREE.Group();
scene.add(ringsGroup);

function placeRing(ring) {
  var x = WORLD_MIN_X + Math.random() * (WORLD_MAX_X - WORLD_MIN_X);
  var z = WORLD_MIN_Z + Math.random() * (WORLD_MAX_Z - WORLD_MIN_Z);
  var y = 22 + Math.random() * 110;
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
var GAME_KEYS = ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Equal", "Minus", "PageUp", "PageDown"];
var keys = {};
// Gear/flaps are toggles, not held controls -- flipped once per physical press (e.repeat
// guards against the OS's key-repeat re-firing keydown while held).
var gearDown = true;
var flapsDown = false;
// The throttle is a real percentage (0-100) you set directly, like an actual throttle
// lever -- hold + / - to move it, and it stays right where you leave it (no auto-return).
// Space/the boost button also push it toward 100 (the touch-friendly, no-fine-control
// path); on the ground, the up/down throttle keys do the same for backward-compatible feel.
var throttlePercent = 0;
var THROTTLE_RATE = 65; // %/sec
var cameraMode = "chase"; // chase | cockpit
window.addEventListener("keydown", function (e) {
  keys[e.code] = true;
  if (GAME_KEYS.indexOf(e.code) !== -1) e.preventDefault();
  if (state !== "playing" || e.repeat) return;
  if (e.code === "KeyH") {
    gearDown = !gearDown;
    gearStatusEl.textContent = gearDown ? "GEAR DOWN" : "GEAR UP";
    showToast(gearDown ? "Gear down" : "Gear up");
  } else if (e.code === "KeyG") {
    flapsDown = !flapsDown;
    flapsStatusEl.textContent = flapsDown ? "FLAPS DOWN" : "FLAPS UP";
    showToast(flapsDown ? "Flaps down" : "Flaps up");
  } else if (e.code === "KeyC") {
    cameraMode = cameraMode === "chase" ? "cockpit" : "chase";
    document.body.classList.toggle("cockpit-view", cameraMode === "cockpit");
    showToast(cameraMode === "cockpit" ? "Cockpit view" : "Chase camera");
  }
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

var throttlingDown = false;
throttleDownBtn.addEventListener("pointerdown", function (e) {
  e.preventDefault();
  throttlingDown = true;
});
throttleDownBtn.addEventListener("pointerup", function () {
  throttlingDown = false;
});
throttleDownBtn.addEventListener("pointercancel", function () {
  throttlingDown = false;
});

// ---------------------------------------------------------------------------
// Flight state + physics
// ---------------------------------------------------------------------------
var state = "ready"; // ready | playing | over
var grounded = true;
var yaw, pitch, roll, speed, score, vertSpeed;
var TURN_RATE_BASE = 1.6;
var MAX_PITCH = Math.PI / 3;
var GROUND_Y = 0.9;
var LANDING_MAX_TILT = 0.35;

var stats; // active plane's tuning, set on start
var airborneElapsed = 0; // guards against rapidly re-triggering the landing bonus by skipping/bouncing

// Wind — a fresh random direction/speed each flight, like real METAR conditions at
// takeoff. Reported (and blows from) the compass direction it's reported from, same
// convention as a real ATIS/METAR; drifts the plane sideways while airborne only (ground
// taxi stays predictable) and adds a little turbulence jitter scaled by its strength.
var windFromDeg = 0;
var windKts = 0;
var windPushX = 0, windPushZ = 0;
function rollWind() {
  windFromDeg = Math.floor(Math.random() * 360);
  windKts = Math.round(Math.random() * 15);
  var pushDeg = (windFromDeg + 180) % 360;
  var pushRad = (pushDeg * Math.PI) / 180;
  var pushMps = windKts / MPS_TO_KNOTS;
  windPushX = Math.sin(pushRad) * pushMps;
  windPushZ = -Math.cos(pushRad) * pushMps;
  windEl.textContent = "WIND " + String(windFromDeg).padStart(3, "0") + "°/" + windKts + "KT";
}

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
  var city = CITIES[currentCityIndex];
  stats = PLANE_PRESETS[selectedPresetIndex];
  placeOnRunwayStart(plane, city.runway);
  plane.visible = true;
  yaw = plane.rotation.y;
  pitch = 0;
  roll = 0;
  speed = 0;
  grounded = true;
  gearDown = true;
  flapsDown = false;
  throttlePercent = 0;
  gearStatusEl.textContent = "GEAR DOWN";
  flapsStatusEl.textContent = "FLAPS UP";
  throttleStatusEl.textContent = "THROTTLE 0%";
  score = 0;
  scoreEl.textContent = "Score: 0";
  statusEl.textContent = "ON RUNWAY";
  for (var i = 0; i < rings.length; i++) placeRing(rings[i]);
  camPos.copy(plane.position);
  camLook.copy(plane.position);
  clearCrashEffects();
  crashCamTimer = 0;
  shakeTimer = 0;
  rollWind();
  stallWarningEl.classList.remove("show");
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
  vertSpeed = 0;

  // The throttle is a direct percentage (0-100), held wherever you leave it -- like an
  // actual throttle lever, not a target something else chases. +/- move it in either
  // state; Space/the boost button (and, on the ground only, the up/down throttle keys,
  // kept for backward-compatible feel) push it toward full for the no-fine-control path.
  var throttleAdjust = 0;
  if (keys["Equal"] || keys["PageUp"]) throttleAdjust = 1;
  if (keys["Minus"] || keys["PageDown"]) throttleAdjust = -1;
  if (wantsBoost) throttleAdjust = 1;
  if (throttlingDown) throttleAdjust = -1;
  if (grounded) {
    if (throttlePitchInput > 0) throttleAdjust = 1;
    else if (throttlePitchInput < 0) throttleAdjust = -1;
  }
  if (throttleAdjust !== 0) {
    throttlePercent = Math.max(0, Math.min(100, throttlePercent + throttleAdjust * THROTTLE_RATE * dt));
    throttleStatusEl.textContent = "THROTTLE " + Math.round(throttlePercent) + "%";
  }
  var speedCap = stats.boostSpeed * (throttlePercent / 100);

  if (grounded) {
    stallWarningEl.classList.remove("show"); // stall only applies airborne
    // ground handling: steer, throttle sets ground accel directly, lift off past takeoff speed.
    yaw += yawInput * (TURN_RATE_BASE * 0.5) * dt;
    var accel = (stats.groundAccel + 4) * (throttlePercent / 100) - 4;
    speed = Math.max(0, Math.min(speedCap, speed + accel * dt));
    pitch = 0;
    roll = 0;

    plane.rotation.order = "YXZ";
    plane.rotation.set(0, yaw, 0);
    forwardVec.set(0, 0, -1).applyEuler(plane.rotation);
    plane.position.addScaledVector(forwardVec, speed * dt);
    plane.position.y = GROUND_Y;

    // Flaps shorten the takeoff roll, same as on a real plane.
    var effectiveTakeoffSpeed = flapsDown ? stats.takeoffSpeed * 0.8 : stats.takeoffSpeed;
    if (speed >= effectiveTakeoffSpeed && throttlePercent > 40) {
      grounded = false;
      airborneElapsed = 0;
      pitch = 0.18;
      statusEl.textContent = "AIRBORNE";
      showToast("Wheels up!");
    }
  } else {
    airborneElapsed += dt;

    // Stall: below this speed there isn't enough lift, so the nose drops on its own and
    // your controls go mushy -- flaps lower the stall speed, same as on a real plane. The
    // only way out is what a real pilot does too: pitch down and dive to regain airspeed.
    var stallSpeed = stats.takeoffSpeed * (flapsDown ? 0.45 : 0.6);
    var stalling = speed < stallSpeed;
    var controlAuth = stalling ? 0.2 : 1;
    stallWarningEl.classList.toggle("show", stalling);

    yaw += yawInput * stats.turnRate * controlAuth * dt;
    pitch += throttlePitchInput * stats.pitchRate * controlAuth * dt;
    if (stalling) pitch -= 1.1 * dt; // the forced nose-drop of an actual stall break
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    roll += (yawInput * -0.7 - roll) * 4 * dt;
    // Light turbulence jitter, scaled by wind strength.
    if (windKts > 0) {
      roll += (Math.random() - 0.5) * windKts * 0.008;
      pitch += (Math.random() - 0.5) * windKts * 0.004;
    }

    // Flying with the gear and/or flaps out costs real speed -- the payoff for
    // remembering to retract them after takeoff (and the reason to extend them again
    // before landing is a deliberate trade, not free). Diving adds real airspeed too,
    // same as gravity assisting a real plane -- which is what makes overspeed reachable.
    var dragMult = (gearDown ? 0.8 : 1) * (flapsDown ? 0.65 : 1);
    var diveBonus = pitch < 0 ? -pitch * 55 : 0;
    var targetSpeed = speedCap * dragMult + diveBonus;
    speed += (targetSpeed - speed) * Math.min(1, dt * 2);

    plane.rotation.order = "YXZ";
    plane.rotation.set(pitch, yaw, roll);
    forwardVec.set(0, 0, -1).applyEuler(plane.rotation);
    plane.position.addScaledVector(forwardVec, speed * dt);
    plane.position.x += windPushX * dt;
    plane.position.z += windPushZ * dt;
    vertSpeed = forwardVec.y * speed;

    // Overspeed: past this, aerodynamic stress is enough to break the airframe -- a real
    // risk when diving hard at high throttle, not something that happens by just cruising.
    var neverExceedSpeed = stats.boostSpeed * 1.15;
    if (speed > neverExceedSpeed) {
      return crash("Overspeed! Structural failure!");
    }

    if (plane.position.y > CEILING_Y) plane.position.y = CEILING_Y;

    // You can land anywhere over land, not just the runway — only speed/attitude/sink-rate
    // need to be safe, and you need to actually be over a city (not open ocean). This must
    // live here, inside the airborne branch, using THIS frame's freshly computed vertSpeed:
    // checking it after the grounded/airborne if-else (as a shared `!grounded` check) used
    // to also fire on the very same frame a takeoff just happened, reading vertSpeed's stale
    // initial value of 0 (which reads as "safe") and immediately snapping the plane back
    // down — so it could never actually leave the ground.
    if (plane.position.y <= GROUND_MIN_Y && vertSpeed <= 3) {
      var overLand = isOverAnyCityLand(plane.position.x, plane.position.z);
      if (!overLand) {
        return crash("Splashed down in the ocean!");
      }
      // Flaps lower the stall speed on a real plane, so they widen the safe landing
      // speed margin here too -- a real tradeoff for the drag penalty they cost in flight.
      var safeSpeed = speed <= stats.cruiseSpeed * (flapsDown ? 1.5 : 1.15);
      var safeAttitude = Math.abs(pitch) < LANDING_MAX_TILT && Math.abs(roll) < LANDING_MAX_TILT;
      var safeSink = vertSpeed > -16;

      if (!gearDown) {
        return crash("Gear up! Bellied in!");
      }
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

  plane.userData.gearGroup.visible = gearDown;
  plane.userData.flapsGroup.children.forEach(function (pivot) {
    pivot.rotation.x = flapsDown ? 0.6 : 0;
  });

  plane.position.x = Math.max(WORLD_MIN_X, Math.min(WORLD_MAX_X, plane.position.x));
  plane.position.z = Math.max(WORLD_MIN_Z, Math.min(WORLD_MAX_Z, plane.position.z));

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

  altEl.textContent = "ALT " + Math.round(plane.position.y * M_TO_FEET) + " FT";
  spdEl.textContent = "IAS " + Math.round(speed * MPS_TO_KNOTS) + " KT";
  var headingDeg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  hdgEl.textContent = "HDG " + String(Math.round(headingDeg)).padStart(3, "0") + "°";
  vsEl.textContent = "VS " + (vertSpeed >= 0 ? "+" : "") + Math.round(vertSpeed * M_TO_FEET * 60) + " FPM";

  if (cameraMode === "cockpit") {
    // Rigidly attached to the plane's actual orientation (not a lookAt), so the horizon
    // visibly tilts with bank/pitch, same as sitting in a real cockpit.
    plane.updateMatrixWorld(true);
    var eyeLocal = plane.userData.cockpitOffset || new THREE.Vector3(0, 0.8, -0.5);
    camera.position.copy(plane.localToWorld(eyeLocal.clone()));
    camera.quaternion.copy(plane.quaternion);
  } else {
    var behind = forwardVec.clone().multiplyScalar(-18);
    var desiredCamPos = plane.position.clone().add(behind).add(new THREE.Vector3(0, 6, 0));
    camPos.lerp(desiredCamPos, Math.min(1, dt * 5));
    camLook.lerp(plane.position, Math.min(1, dt * 7));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  }

  if (cameraMode === "cockpit") drawInstrumentPanel();
}

function crash(reason) {
  state = "over";
  document.body.classList.remove("playing");
  stallWarningEl.classList.remove("show");
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
// Minimap — a simple top-down world map showing every city and the plane's live
// position/heading, so it's clear where you are and which way to go for the next one.
// ---------------------------------------------------------------------------
var MINIMAP_PAD = 22;
function worldToMinimap(x, z) {
  var w = minimapCanvas.width, h = minimapCanvas.height;
  var u = (x - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X);
  var v = (z - WORLD_MIN_Z) / (WORLD_MAX_Z - WORLD_MIN_Z);
  return {
    mx: MINIMAP_PAD + u * (w - MINIMAP_PAD * 2),
    my: MINIMAP_PAD + v * (h - MINIMAP_PAD * 2),
  };
}

function drawMinimap() {
  var w = minimapCanvas.width, h = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.fillStyle = "#2f5f7d";
  minimapCtx.fillRect(0, 0, w, h);

  CITIES.forEach(function (city, index) {
    var p = worldToMinimap(city.worldOffset.x, city.worldOffset.z);
    var r = 7 + (city.worldHalf / 1050) * 6;
    minimapCtx.fillStyle = index === currentCityIndex ? "#e8d9a8" : "#c9bd93";
    minimapCtx.beginPath();
    minimapCtx.arc(p.mx, p.my, r, 0, Math.PI * 2);
    minimapCtx.fill();
    minimapCtx.fillStyle = "#0a1226";
    minimapCtx.font = "bold 15px sans-serif";
    minimapCtx.textAlign = "center";
    minimapCtx.textBaseline = "middle";
    minimapCtx.fillText(city.code, p.mx, p.my + 1);
  });

  if (worldReady && plane) {
    var pp = worldToMinimap(plane.position.x, plane.position.z);
    minimapCtx.save();
    minimapCtx.translate(pp.mx, pp.my);
    // World Z maps directly to canvas Y and X to canvas X, but canvas rotate() is
    // clockwise for +angle while +yaw turns the plane counter-clockwise in that mapping
    // (forward = (-sin(yaw), -cos(yaw))) -- negate to match.
    minimapCtx.rotate(-(yaw || 0));
    minimapCtx.fillStyle = "#00f0ff";
    minimapCtx.shadowColor = "rgba(0,240,255,0.9)";
    minimapCtx.shadowBlur = 8;
    minimapCtx.beginPath();
    minimapCtx.moveTo(0, -11);
    minimapCtx.lineTo(7, 8);
    minimapCtx.lineTo(0, 4);
    minimapCtx.lineTo(-7, 8);
    minimapCtx.closePath();
    minimapCtx.fill();
    minimapCtx.restore();
  }
}

// ---------------------------------------------------------------------------
// Instrument panel — drawn only in cockpit view, replacing the text HUD readouts
// with real analog-style gauges: heading, airspeed, attitude indicator (artificial
// horizon), altimeter, and vertical speed, plus a small annunciator strip.
// ---------------------------------------------------------------------------
function gaugeBezel(cx, cy, r, label) {
  var ctx = panelCtx;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1f29";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#3a4250";
  ctx.stroke();
  ctx.fillStyle = "#8a94a6";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, cx, cy - r + 16);
}

// A simple wrap-around needle gauge: fraction 0-1 maps to a full clockwise sweep from
// the top. Good for quantities that only increase (airspeed) or naturally wrap (a
// single-needle altimeter, same as a real one's short/fast hand).
function gaugeNeedle(cx, cy, r, fraction, color) {
  var ctx = panelCtx;
  fraction = Math.max(0, Math.min(1, fraction));
  var angle = fraction * Math.PI * 2;
  ctx.strokeStyle = "rgba(138,148,166,0.5)";
  ctx.lineWidth = 1.5;
  for (var i = 0; i < 8; i++) {
    var a = (i / 8) * Math.PI * 2;
    var x1 = cx + Math.sin(a) * (r - 9), y1 = cy - Math.cos(a) * (r - 9);
    var x2 = cx + Math.sin(a) * (r - 3), y2 = cy - Math.cos(a) * (r - 3);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(angle) * (r - 18), cy - Math.cos(angle) * (r - 18));
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
}

function gaugeDigital(cx, cy, r, text, color) {
  var ctx = panelCtx;
  ctx.fillStyle = color || "#e6ecff";
  ctx.font = "bold 15px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + r * 0.52);
}

function drawHeadingGauge(cx, cy, r) {
  var ctx = panelCtx;
  gaugeBezel(cx, cy, r, "HDG");
  var headingDeg = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
  ctx.fillStyle = "#cfd8e3";
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(function (m) {
    var rad = (m[1] * Math.PI) / 180;
    ctx.fillText(m[0], cx + Math.sin(rad) * (r - 16), cy - Math.cos(rad) * (r - 16));
  });
  ctx.strokeStyle = "rgba(207,216,227,0.5)";
  ctx.lineWidth = 1.5;
  for (var deg = 0; deg < 360; deg += 30) {
    var rad2 = (deg * Math.PI) / 180;
    var x1 = cx + Math.sin(rad2) * (r - 6), y1 = cy - Math.cos(rad2) * (r - 6);
    var x2 = cx + Math.sin(rad2) * (r - 2), y2 = cy - Math.cos(rad2) * (r - 2);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  var hr = (headingDeg * Math.PI) / 180;
  ctx.strokeStyle = "#ffd400";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(hr) * (r - 24), cy - Math.cos(hr) * (r - 24));
  ctx.stroke();
  gaugeDigital(cx, cy, r, String(Math.round(headingDeg)).padStart(3, "0") + "°", "#ffd400");
}

function drawAttitudeGauge(cx, cy, r) {
  var ctx = panelCtx;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  // horizon tilts with roll and shifts with pitch -- the pixels-per-radian scale is
  // arbitrary (there's no real "field of view" for this instrument), just tuned so a
  // moderate climb/dive visibly moves the line without pinning it at extreme pitch.
  ctx.translate(cx, cy);
  ctx.rotate(roll);
  var pitchOffset = pitch * 120;
  ctx.fillStyle = "#3d7bc4";
  ctx.fillRect(-r * 2, -r * 2 + pitchOffset, r * 4, r * 2);
  ctx.fillStyle = "#7a5230";
  ctx.fillRect(-r * 2, pitchOffset, r * 4, r * 2);
  ctx.strokeStyle = "#e6ecff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-r * 2, pitchOffset);
  ctx.lineTo(r * 2, pitchOffset);
  ctx.stroke();
  ctx.restore();
  // fixed aircraft symbol (doesn't rotate with the horizon -- it represents the plane's
  // own nose, so the horizon moves relative to it, not the other way around)
  ctx.strokeStyle = "#ffd400";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 26, cy);
  ctx.lineTo(cx - 8, cy);
  ctx.moveTo(cx + 8, cy);
  ctx.lineTo(cx + 26, cy);
  ctx.stroke();
  ctx.fillStyle = "#ffd400";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#0a1226";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#8a94a6";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.fillText("ATT", cx, cy - r + 16);
}

function drawAirspeedGauge(cx, cy, r) {
  var maxKt = Math.max(120, stats.boostSpeed * MPS_TO_KNOTS * 1.15);
  var iasKt = speed * MPS_TO_KNOTS;
  gaugeBezel(cx, cy, r, "IAS");
  gaugeNeedle(cx, cy, r, iasKt / maxKt, "#00f0ff");
  gaugeDigital(cx, cy, r, Math.round(iasKt) + " KT", "#00f0ff");
}

function drawAltimeterGauge(cx, cy, r) {
  var altFt = plane.position.y * M_TO_FEET;
  gaugeBezel(cx, cy, r, "ALT");
  // single needle wraps every 1000ft, same as the fast hand on a real 3-needle altimeter
  // -- the digital readout resolves which thousand you're actually in.
  gaugeNeedle(cx, cy, r, (altFt % 1000) / 1000, "#7bff5a");
  gaugeDigital(cx, cy, r, Math.round(altFt) + " FT", "#7bff5a");
}

function drawVsiGauge(cx, cy, r) {
  var ctx = panelCtx;
  var vsFpm = vertSpeed * M_TO_FEET * 60;
  var maxVs = 2500;
  var f = Math.max(-1, Math.min(1, vsFpm / maxVs));
  gaugeBezel(cx, cy, r, "VS");
  // half-circle sweep: max descent at left (-90deg), level at top, max climb at right
  // (+90deg) -- reads intuitively left-down / right-up without a full-circle wraparound.
  ctx.strokeStyle = "rgba(138,148,166,0.5)";
  ctx.lineWidth = 1.5;
  [-1, -0.5, 0, 0.5, 1].forEach(function (t) {
    var a = (-90 + t * 90) * (Math.PI / 180);
    var x1 = cx + Math.sin(a) * (r - 9), y1 = cy - Math.cos(a) * (r - 9);
    var x2 = cx + Math.sin(a) * (r - 3), y2 = cy - Math.cos(a) * (r - 3);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
  var angle = (-90 + f * 90) * (Math.PI / 180);
  ctx.strokeStyle = "#ff7a1a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.sin(angle) * (r - 18), cy - Math.cos(angle) * (r - 18));
  ctx.stroke();
  gaugeDigital(cx, cy, r, (vsFpm >= 0 ? "+" : "") + Math.round(vsFpm) + " FPM", "#ff7a1a");
}

function drawInstrumentPanel() {
  var w = panelCanvas.width, h = panelCanvas.height;
  var ctx = panelCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#12161d";
  ctx.fillRect(0, 0, w, h);

  var cy = 95;
  drawHeadingGauge(90, cy, 78);
  drawAirspeedGauge(270, cy, 78);
  drawAttitudeGauge(450, cy, 92);
  drawAltimeterGauge(630, cy, 78);
  drawVsiGauge(810, cy, 78);

  ctx.font = "bold 15px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = gearDown ? "#7bff5a" : "#ff5a3c";
  ctx.fillText(gearDown ? "GEAR DOWN" : "GEAR UP", 180, 195);
  ctx.fillStyle = flapsDown ? "#ffd400" : "#5a6270";
  ctx.fillText(flapsDown ? "FLAPS DOWN" : "FLAPS UP", 450, 195);
  ctx.fillStyle = "#00f0ff";
  ctx.fillText("THROTTLE " + Math.round(throttlePercent) + "%", 720, 195);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
var lastTime = null;
function loop(ts) {
  if (lastTime === null) lastTime = ts;
  var dt = Math.min(0.05, (ts - lastTime) / 1000);
  lastTime = ts;

  oceanTexture.offset.x = (ts * 0.000012) % 1;
  oceanTexture.offset.y = (ts * 0.000008) % 1;

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
  } else if (worldReady) {
    var runway = CITIES[currentCityIndex].runway;
    camera.position.set(runway.cx - runway.dirX * (runway.halfLength + 30), 22, runway.cz - runway.dirZ * (runway.halfLength + 30));
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

  if (worldReady) drawMinimap();

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
loadAllCities();
requestAnimationFrame(loop);
