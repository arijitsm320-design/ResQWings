// Wrap all logic in DOMContentLoaded to ensure elements exist

document.addEventListener('DOMContentLoaded', function() {
  // -------------------------
  // Elements
  // -------------------------
  const input = document.getElementById('search');
  const suggestionsBox = document.getElementById('suggestions');
  const searchBtn = document.getElementById('searchBtn');

  // Canvas for drawing drone traces
  const scanCanvas = document.createElement('canvas');
  scanCanvas.id = 'scanCanvas';
  scanCanvas.style.position = 'absolute';
  scanCanvas.style.top = 0;
  scanCanvas.style.left = 0;
  scanCanvas.style.pointerEvents = 'none';
  document.body.appendChild(scanCanvas);
  const ctx = scanCanvas.getContext('2d');

  // -------------------------
  // Map Setup
  // -------------------------
  const map = L.map('map').setView([20, 30], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  let searchMarker = null;

  // -------------------------
  // Canvas Setup
  // -------------------------
  function resizeCanvas() {
    scanCanvas.width = map.getSize().x;
    scanCanvas.height = map.getSize().y;
  }
  resizeCanvas();
  map.on('resize move', resizeCanvas);
  map.on('zoomend', () => ctx.clearRect(0, 0, scanCanvas.width, scanCanvas.height));

  // -------------------------
  // Autocomplete and Search
  // -------------------------
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  }

  function nominatimUrl(query) {
    return `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(query)}`;
  }

  const fetchSuggestions = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) { suggestionsBox.style.display = 'none'; return; }
    try {
      const res = await fetch(nominatimUrl(q));
      const data = await res.json();
      suggestionsBox.innerHTML = '';
      data.forEach(place => {
        const div = document.createElement('div');
        div.textContent = place.display_name;
        div.addEventListener('click', () => { input.value = place.display_name; selectPlace(place); suggestionsBox.style.display = 'none'; });
        suggestionsBox.appendChild(div);
      });
      suggestionsBox.style.display = 'block';
    } catch (err) { console.error(err); suggestionsBox.style.display = 'none'; }
  }, 300);

  input.addEventListener('input', fetchSuggestions);
  document.addEventListener('click', evt => { if(!evt.target.closest('#controls')) suggestionsBox.style.display='none'; });

  async function searchPlace() {
    const q = input.value.trim();
    if (!q) return alert('Enter a place name first');
    try {
      const res = await fetch(nominatimUrl(q));
      const data = await res.json();
      if (!data.length) return alert('Place not found');
      selectPlace(data[0]);
    } catch (err) { console.error(err); alert('Search failed'); }
  }

  function selectPlace(place) {
    const lat = parseFloat(place.lat);
    const lon = parseFloat(place.lon);
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([lat, lon], { title: place.display_name }).addTo(map);
    searchMarker.bindPopup(`<strong>${place.display_name}</strong>`).openPopup();
    map.setView([lat, lon], 14);
  }

  searchBtn.addEventListener('click', searchPlace);
  input.addEventListener('keydown', ev => { if(ev.key==='Enter'){ ev.preventDefault(); searchPlace(); suggestionsBox.style.display='none'; }});

  // -------------------------
  // Drone count selection (1-5)
  const droneSelect = document.createElement('select');
  droneSelect.className = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm mt-2 mb-2 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500';
  for (let i = 1; i <= 5; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${i} Drone${i>1?'s':''}`;
    droneSelect.appendChild(opt);
  }
  document.getElementById('controls').appendChild(droneSelect);

  // After droneSelect is appended
  function updateActiveDronesCount() {
    const count = droneSelect.value;
    document.getElementById('active-drones-count').textContent = `${count}/${count}`;
  }
  droneSelect.addEventListener('change', updateActiveDronesCount);
  updateActiveDronesCount();

  // -------------------------
  // Reset Button
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '🔄 Reset';
  resetBtn.className = 'bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition w-full mt-2';
  resetBtn.addEventListener('click', () => {
    // Clear canvas
    ctx.clearRect(0, 0, scanCanvas.width, scanCanvas.height);

    // Remove all layers except the base tile layer
    map.eachLayer(layer => {
      if (!(layer instanceof L.TileLayer)) {
        map.removeLayer(layer);
      }
    });

    // Reset temporary vars
    clickCount = 0;
    boundsTemp = [];

    // Reset search input
    input.value = '';

    // Reset drone select
    droneSelect.value = '1';

    // Reset map view
    map.setView([20, 0], 2);
  });
  document.getElementById('controls').appendChild(resetBtn);

  // -------------------------
  // Simulated GPS feed for drones
  function simulateGPS(area, speed=0.0001, singleScan=true) {
    let lat = area.latMax;
    let lng = area.lngMin;
    let dir = 1;
    return function nextPosition() {
      if(singleScan && lat <= area.latMin) return {lat: area.latMin, lng};
      lng += dir*speed;
      if (lng > area.lngMax) { lng = area.lngMax; lat -= 0.0005; dir = -1; }
      else if (lng < area.lngMin) { lng = area.lngMin; lat -= 0.0005; dir = 1; }
      return {lat, lng};
    }
  }

  // -------------------------
  // Multi-drone scanning
  function startScanningMultipleDrones(bounds, numDrones){
    const latMin = bounds[0][0], latMax = bounds[1][0];
    const lngMin = bounds[0][1], lngMax = bounds[1][1];
    const sectionWidth = (lngMax - lngMin) / numDrones;
    const largestAreaSize = (latMax - latMin) * sectionWidth;

    const drones = [];

    for(let i=0;i<numDrones;i++){
      const area = { latMin, latMax, lngMin: lngMin + i*sectionWidth, lngMax: lngMin + (i+1)*sectionWidth };
      const areaSize = (area.latMax - area.latMin) * (area.lngMax - area.lngMin);
      const maxSpeed = 0.0005, minSpeed = 0.00005;
      const normalizedSpeed = minSpeed + (maxSpeed - minSpeed)*(areaSize/largestAreaSize);

      const gpsDot = simulateGPS(area, normalizedSpeed, true);
      const color = ['red','blue','orange','purple','green'][i];
      const marker = L.circleMarker([area.latMax, area.lngMin], {radius:10,color,fillColor:color,fillOpacity:1}).addTo(map);
      drones.push({gpsDot, marker, area, finished:false});
    }

    ctx.clearRect(0,0,scanCanvas.width,scanCanvas.height);

    function animateDots(){
      let allFinished = true;
      drones.forEach(d=>{
        if(!d.finished){
          const pos = d.gpsDot();
          d.marker.setLatLng([pos.lat,pos.lng]);
          const topLeft = map.latLngToContainerPoint([d.area.latMax,d.area.lngMin]);
          const current = map.latLngToContainerPoint([pos.lat,pos.lng]);
          ctx.fillStyle = d.marker.options.fillColor+'33';
          ctx.fillRect(topLeft.x,current.y,current.x-topLeft.x,topLeft.y-current.y);
          if(pos.lat <= d.area.latMin) d.finished = true;
        }
        if(!d.finished) allFinished = false;
      });

      if(!allFinished) requestAnimationFrame(animateDots);
      else {
        drones.forEach(d=>d.marker.remove());
        const boundsRect = L.latLngBounds([latMin,lngMin],[latMax,lngMax]);
        L.rectangle(boundsRect,{color:'green',weight:2}).addTo(map);
        map.fitBounds(boundsRect.pad(0.05));
        L.popup({closeOnClick:false, autoClose:false})
          .setLatLng(boundsRect.getCenter())
          .setContent("<b>Scanning Completed: Zoomable Map</b>")
          .openOn(map);
      }
    }

    animateDots();
  }

  // -------------------------
  // Rectangle selection for scanning
  let clickCount=0, boundsTemp=[];
  map.on('click', e=>{
    boundsTemp.push([e.latlng.lat,e.latlng.lng]);
    clickCount++;
    if(clickCount===2){
      const latMin=Math.min(boundsTemp[0][0],boundsTemp[1][0]);
      const latMax=Math.max(boundsTemp[0][0],boundsTemp[1][0]);
      const lngMin=Math.min(boundsTemp[0][1],boundsTemp[1][1]);
      const lngMax=Math.max(boundsTemp[0][1],boundsTemp[1][1]);

      L.rectangle([[latMin,lngMin],[latMax,lngMax]],{color:'green',weight:1}).addTo(map);

      const numDrones = parseInt(droneSelect.value);
      startScanningMultipleDrones([[latMin,lngMin],[latMax,lngMax]], numDrones);

      clickCount=0; boundsTemp=[];
    }
  });

  // -------------------------
  // Launch New Mission Button (tab switch)
  const launchBtn = document.getElementById('launch-mission-btn');
  const tabSections = document.querySelectorAll('.tab-section');
  if (launchBtn) {
    launchBtn.onclick = () => {
      tabSections.forEach(sec => sec.classList.add('hidden'));
      document.getElementById('mission-section').classList.remove('hidden');
    };
  }
});
