/* EV Verim — telefon üzerinde çalışan, araca yalnızca "okuyarak" bakan enerji verimliliği uygulaması.
   Araçla hiçbir bağlantı kurmaz, komut göndermez. Girdiler: telefon GPS'i + kullanıcının girdiği şarj % + açık harita/hava servisleri. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const SPEEDS = [90, 100, 110, 120, 130];

  // ---------- depolama ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('evv_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('evv_' + k, JSON.stringify(v)); return true; } catch (e) { toast('Kayıt alanı dolu olabilir'); return false; } },
    del(k) { try { localStorage.removeItem('evv_' + k); } catch (e) {} }
  };

  let car = Object.assign({}, EV.DEFAULT_CAR, store.get('car', {}));
  let plan = store.get('plan', null);      // {segs, from, to, startSoc, reserve, speed, totalKm}
  let trip = null;                          // aktif sürüş
  let watchId = null, wakeLock = null;

  function toast(t, ms) {
    const m = $('msg'); m.textContent = t; m.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(() => m.style.display = 'none', ms || 3500);
  }
  const pct = x => Math.round(x * 100) + '%';
  const hm = h => { const m = Math.round(h * 60); return Math.floor(m / 60) + ' sa ' + String(m % 60).padStart(2, '0') + ' dk'; };
  // En kısa toplam süreye 5 dk yakın olanlar içinden en düşük hızı seç (enerji tasarrufu)
  function pickBest(rs) {
    const f = rs.filter(r => r.feasible); if (!f.length) return null;
    const minH = Math.min(...f.map(r => r.totalH));
    return f.filter(r => r.totalH <= minH + 5 / 60).sort((x, y) => x.cruiseKmh - y.cruiseKmh)[0];
  }
  const socClass = s => s < 0.08 ? 'bad' : s < 0.15 ? 'warn' : 'ok';

  // ---------- sekmeler ----------
  function showTab(t) {
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === t));
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.t === t));
    if (t === 'logs') renderLogs();
    if (t === 'settings') renderCarForm();
  }
  document.querySelectorAll('nav a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.t); history.replaceState(null, '', '#' + a.dataset.t); }));
  window.addEventListener('load', () => { const h = location.hash.slice(1); if (['plan', 'drive', 'logs', 'settings'].includes(h)) showTab(h); });

  // ---------- ağ yardımcıları ----------
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url.split('?')[0]);
    return r.json();
  }
  function getPos() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('Konum desteklenmiyor'));
      navigator.geolocation.getCurrentPosition(p => res(p), e => rej(new Error('Konum alınamadı: ' + e.message)), { enableHighAccuracy: true, timeout: 15000 });
    });
  }

  // ---------- adres arama ----------
  const picked = { from: null, to: null };
  async function geocode(q) {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=tr&accept-language=tr&q=' + encodeURIComponent(q);
    return getJSON(u);
  }
  function hookSearch(key) {
    const inp = $(key), list = $(key + 'List');
    let t;
    inp.addEventListener('input', () => {
      picked[key] = null; clearTimeout(t);
      const q = inp.value.trim(); if (q.length < 3) { list.innerHTML = ''; return; }
      t = setTimeout(async () => {
        try {
          const rs = await geocode(q);
          list.innerHTML = '';
          rs.forEach(r => {
            const b = document.createElement('button'); b.textContent = r.display_name;
            b.onclick = () => { picked[key] = { lat: +r.lat, lon: +r.lon, name: r.display_name.split(',').slice(0, 2).join(',') }; inp.value = picked[key].name; list.innerHTML = ''; };
            list.appendChild(b);
          });
        } catch (e) { list.innerHTML = '<div class="mut">Adres araması başarısız</div>'; }
      }, 600);
    });
  }
  hookSearch('from'); hookSearch('to');
  $('gpsFrom').onclick = async () => {
    try { const p = await getPos(); picked.from = { lat: p.coords.latitude, lon: p.coords.longitude, name: 'Mevcut konum' }; $('from').value = 'Mevcut konum'; }
    catch (e) { toast(e.message); }
  };

  async function resolve(key) {
    if (picked[key]) return picked[key];
    const q = $(key).value.trim();
    if (!q && key === 'from') { const p = await getPos(); return { lat: p.coords.latitude, lon: p.coords.longitude, name: 'Mevcut konum' }; }
    if (!q) throw new Error('Varış noktasını girin');
    const rs = await geocode(q); if (!rs.length) throw new Error('"' + q + '" bulunamadı');
    return { lat: +rs[0].lat, lon: +rs[0].lon, name: rs[0].display_name.split(',').slice(0, 2).join(',') };
  }

  // ---------- rota + yükselti + hava ----------
  async function fetchRoute(a, b) {
    const u = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&annotations=speed`;
    const j = await getJSON(u);
    if (!j.routes || !j.routes.length) throw new Error('Rota bulunamadı');
    const r = j.routes[0];
    const speeds = [].concat(...r.legs.map(l => (l.annotation && l.annotation.speed) || []));
    return { coords: r.geometry.coordinates, speeds: speeds.length === r.geometry.coordinates.length - 1 ? speeds : null, distance: r.distance, duration: r.duration };
  }
  async function fetchElevation(pts, status) {
    for (let i = 0; i < pts.length; i += 100) {
      const ch = pts.slice(i, i + 100);
      const u = 'https://api.open-meteo.com/v1/elevation?latitude=' + ch.map(p => p.lat.toFixed(5)).join(',') + '&longitude=' + ch.map(p => p.lon.toFixed(5)).join(',');
      const j = await getJSON(u);
      j.elevation.forEach((e, k) => ch[k].ele = e);
      status('Yükselti verisi ' + Math.min(100, Math.round((i + 100) / pts.length * 100)) + '%');
    }
  }
  async function fetchWeather(pts) {
    const step = Math.max(1, Math.floor(pts.length / 12));
    const s = []; for (let i = 0; i < pts.length; i += step) s.push(pts[i]);
    const u = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m&latitude=' + s.map(p => p.lat.toFixed(3)).join(',') + '&longitude=' + s.map(p => p.lon.toFixed(3)).join(',');
    try {
      let j = await getJSON(u); if (!Array.isArray(j)) j = [j];
      const w = j.map((x, i) => ({ lat: s[i].lat, lon: s[i].lon, tempC: x.current.temperature_2m, precip: x.current.precipitation, windKmh: x.current.wind_speed_10m, windDir: x.current.wind_direction_10m }));
      return (lat, lon) => { let best = w[0], bd = 1e12; for (const q of w) { const d = EV.haversine(lat, lon, q.lat, q.lon); if (d < bd) { bd = d; best = q; } } return best; };
    } catch (e) { return null; }
  }

  // ---------- şarj istasyonları (OSM) ----------
  async function chargersNear(lat, lon, radiusM) {
    const q = `[out:json][timeout:25];(node(around:${radiusM},${lat},${lon})["amenity"="charging_station"];way(around:${radiusM},${lat},${lon})["amenity"="charging_station"];);out center tags;`;
    const j = await getJSON('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return j.elements.map(e => {
      const t = e.tags || {}, la = e.lat || (e.center && e.center.lat), lo = e.lon || (e.center && e.center.lon);
      const dc = !!(t['socket:type2_combo'] || t['socket:ccs'] || t['socket:chademo'] || /dc|ccs|hızlı|fast/i.test(JSON.stringify(t)));
      return { name: t.name || t.operator || t.brand || 'Şarj istasyonu', operator: t.operator || t.brand || '', dc, lat: la, lon: lo, d: EV.haversine(lat, lon, la, lo) };
    }).filter(c => c.lat).sort((a, b) => (b.dc - a.dc) || (a.d - b.d)).slice(0, 5);
  }

  // ---------- planlama ----------
  $('planBtn').onclick = async () => {
    const st = t => $('planStatus').textContent = t;
    $('planBtn').disabled = true;
    try {
      st('Konumlar çözülüyor…');
      const a = await resolve('from'), b = await resolve('to');
      st('Rota alınıyor…');
      const r = await fetchRoute(a, b);
      const pts = EV.resample(r.coords, r.speeds, 1000);
      st('Yükselti verisi…'); await fetchElevation(pts, st);
      st('Hava durumu…'); const wAt = await fetchWeather(pts);
      const segs = EV.buildSegments(pts, wAt);
      plan = { segs, from: a, to: b, startSoc: +$('startSoc').value / 100, reserve: +$('reserve').value / 100, totalKm: segs[segs.length - 1].km, osrmH: r.duration / 3600, weather: !!wAt, created: Date.now() };
      store.set('plan', plan);
      renderPlan();
      st('');
    } catch (e) { st('Hata: ' + e.message); }
    $('planBtn').disabled = false;
  };

  function renderPlan() {
    if (!plan) return;
    const res = EV.compareSpeeds(car, plan.segs, plan.startSoc, plan.reserve, SPEEDS);
    const feas = res.filter(r => r.feasible);
    const best = pickBest(res);
    $('routeInfo').textContent = `${plan.from.name} → ${plan.to.name} · ${plan.totalKm.toFixed(0)} km · başlangıç ${pct(plan.startSoc)}${plan.weather ? ' · hava/rüzgâr dahil' : ''}`;
    let h = '<tr><th>Hız</th><th>kWh/100</th><th>Durak</th><th>Şarj</th><th>Toplam</th></tr>';
    res.forEach(r => {
      if (!r.feasible) { h += `<tr><td>${r.cruiseKmh || ''}</td><td colspan=4 class="bad">${r.reason}</td></tr>`; return; }
      h += `<tr class="${r === best ? 'best' : ''}"><td>${r.cruiseKmh}</td><td>${r.kWhPer100.toFixed(1)}</td><td>${r.stops.length}</td><td>${Math.round(r.chargeMin)} dk</td><td>${hm(r.totalH)}</td></tr>`;
    });
    $('speedTable').innerHTML = h;
    $('resultCard').style.display = 'block';
    const sel = $('planSpeed'); sel.innerHTML = '';
    SPEEDS.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v + ' km/s ile plan'; sel.appendChild(o); });
    sel.value = plan.speed || (best ? best.cruiseKmh : 110);
    sel.onchange = () => { plan.speed = +sel.value; store.set('plan', plan); renderStops(); };
    plan.speed = +sel.value;
    $('stopsCard').style.display = 'block';
    renderStops();
  }

  async function renderStops() {
    const r = EV.simulate(car, plan.segs, plan.speed, plan.startSoc, plan.reserve);
    const box = $('stopsList');
    drawProfile(r);
    if (!r.feasible) { box.innerHTML = `<div class="bad">${r.reason}</div>`; return; }
    let h = `<div class="mut">Sürüş ${hm(r.driveH)} · şarj ${Math.round(r.chargeMin)} dk · varış <b class="${socClass(r.arriveSoc)}">${pct(r.arriveSoc)}</b></div>`;
    if (!r.stops.length) h += '<div class="stop">Şarj durağı gerekmiyor.</div>';
    r.stops.forEach((s, i) => {
      h += `<div class="stop" id="stop${i}"><b>${i + 1}. durak · ~${Math.round(s.km)}. km</b><br>Varış ${pct(s.arriveSoc)} → <b>${pct(s.targetSoc)}</b> (${Math.round(s.minutes)} dk)<div class="mut">İstasyonlar aranıyor…</div></div>`;
    });
    box.innerHTML = h;
    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i];
      // rezerve inmeden ~15 km önceki noktanın çevresinde ara
      const idx = Math.max(0, s.segIndex - 15), p = plan.segs[idx];
      try {
        const cs = await chargersNear(p.lat, p.lon, 15000);
        const el = $('stop' + i).querySelector('.mut');
        el.innerHTML = cs.length ? cs.map(c => `<a style="color:var(--acc)" href="https://maps.apple.com/?daddr=${c.lat},${c.lon}">${c.dc ? '⚡ DC · ' : ''}${c.name}${c.operator && c.operator !== c.name ? ' (' + c.operator + ')' : ''}</a> · ${(c.d / 1000).toFixed(1)} km`).join('<br>') : 'Bu bölgede OSM kaydı bulunamadı — şarj uygulamanızdan kontrol edin.';
      } catch (e) { $('stop' + i).querySelector('.mut').textContent = 'İstasyon araması başarısız.'; }
    }
  }

  function drawProfile(r) {
    const c = $('profile'), x = c.getContext('2d'), W = c.width, H = c.height;
    x.clearRect(0, 0, W, H);
    const segs = plan.segs, n = segs.length;
    const els = segs.map(s => s.ele), mn = Math.min(...els), mx = Math.max(...els);
    x.fillStyle = 'rgba(139,149,181,.25)'; x.beginPath(); x.moveTo(0, H);
    segs.forEach((s, i) => x.lineTo(i / (n - 1) * W, H - ((s.ele - mn) / (mx - mn || 1)) * H * 0.6));
    x.lineTo(W, H); x.fill();
    if (r.trace) {
      x.strokeStyle = '#4da3ff'; x.lineWidth = 4; x.beginPath();
      r.trace.forEach((s, i) => { const px = i / (n - 1) * W, py = H - s * H; i ? x.lineTo(px, py) : x.moveTo(px, py); });
      x.stroke();
      x.strokeStyle = '#ff5d6c'; x.setLineDash([8, 8]); x.lineWidth = 2; x.beginPath();
      x.moveTo(0, H - plan.reserve * H); x.lineTo(W, H - plan.reserve * H); x.stroke(); x.setLineDash([]);
    }
    x.fillStyle = '#8b95b5'; x.font = '22px sans-serif';
    x.fillText(Math.round(mx) + ' m', 6, H - 0.6 * H - 6);
  }

  $('goDrive').onclick = () => { showTab('drive'); history.replaceState(null, '', '#drive'); };

  // ---------- sürüş modu ----------
  function nearestIdx(lat, lon, from) {
    const segs = plan.segs; let best = from || 0, bd = 1e12;
    const a = Math.max(0, (from || 0) - 30), b = Math.min(segs.length, (from || 0) + 400);
    for (let i = a; i < b; i++) { const d = EV.haversine(lat, lon, segs[i].lat, segs[i].lon); if (d < bd) { bd = d; best = i; } }
    if (bd > 5000) { for (let i = 0; i < segs.length; i++) { const d = EV.haversine(lat, lon, segs[i].lat, segs[i].lon); if (d < bd) { bd = d; best = i; } } }
    return { i: best, off: bd };
  }

  async function requestWake() {
    try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (trip && document.visibilityState === 'visible') requestWake(); });

  $('startTrip').onclick = async () => {
    if (!plan) { toast('Önce Plan sekmesinden rota hesaplayın'); return; }
    const soc0 = +($('socIn').value || Math.round(plan.startSoc * 100));
    trip = { id: Date.now(), start: Date.now(), from: plan.from.name, to: plan.to.name, pts: [], soc: [{ t: Date.now(), soc: soc0 / 100, km: 0, eModel: 0 }],
      idx: 0, km: 0, eModel: 0, eSinceSoc: 0, last: null, speeds: [], calib0: car.calib };
    store.set('activeTrip', trip);
    startWatch();
  };
  function startWatch() {
    if (!navigator.geolocation) { toast('Konum desteklenmiyor'); return; }
    watchId = navigator.geolocation.watchPosition(onFix, e => $('dGps').textContent = 'GPS hatası: ' + e.message, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    requestWake();
    $('startTrip').disabled = true; $('stopTrip').disabled = false;
    toast('Sürüş kaydı başladı. Ekran açık kalmalı.');
  }
  $('stopTrip').onclick = () => {
    if (!trip) return;
    if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null;
    try { wakeLock && wakeLock.release(); } catch (e) {}
    trip.end = Date.now();
    const trips = store.get('trips', []); trips.unshift(summarize(trip)); store.set('trips', trips);
    store.set('trip_' + trip.id, trip); store.del('activeTrip');
    trip = null; $('startTrip').disabled = false; $('stopTrip').disabled = true;
    toast('Sürüş kaydedildi');
  };

  let lastCalc = 0, lastSave = 0;
  function onFix(p) {
    const c = p.coords, now = p.timestamp || Date.now();
    let v = c.speed != null && c.speed >= 0 ? c.speed : null;
    if (trip.last) {
      const d = EV.haversine(trip.last.lat, trip.last.lon, c.latitude, c.longitude), dt = (now - trip.last.t) / 1000;
      if (v == null && dt > 0) v = d / dt;
      if (d > 2 && d < 2000 && c.accuracy < 50) {
        const m = nearestIdx(c.latitude, c.longitude, trip.idx);
        trip.idx = m.i;
        const grade = plan.segs[m.i] ? plan.segs[m.i].grade : 0;
        // GPS sıçramalarına karşı hız 3–55 m/s (≈10–200 km/s) aralığına sınırlanır
        const vv = Math.min(55, Math.max(v || d / Math.max(dt, 1), 3));
        const e = EV.segmentKWh(car, vv, d, grade, plan.segs[m.i] || {});
        trip.eModel += e; trip.eSinceSoc += e; trip.km += d / 1000;
      }
    } else {
      trip.idx = nearestIdx(c.latitude, c.longitude, 0).i;
    }
    trip.last = { lat: c.latitude, lon: c.longitude, t: now };
    if (v != null && v > 70) v = null; // gerçek dışı GPS hızı
    trip.speeds.push({ t: now, v: v || 0 }); while (trip.speeds.length && now - trip.speeds[0].t > 120000) trip.speeds.shift();
    if (!trip.pts.length || now - trip.pts[trip.pts.length - 1][0] >= 2000)
      trip.pts.push([now, +c.latitude.toFixed(6), +c.longitude.toFixed(6), c.altitude != null ? Math.round(c.altitude) : null, v != null ? +(v * 3.6).toFixed(1) : null, Math.round(c.accuracy)]);
    $('dSpeed').textContent = v != null ? Math.round(v * 3.6) : '–';
    $('dGps').textContent = `GPS ±${Math.round(c.accuracy)} m · ${trip.km.toFixed(1)} km kaydedildi`;
    if (now - lastCalc > 10000) { lastCalc = now; recalcLive(); }
    if (now - lastSave > 30000) { lastSave = now; store.set('activeTrip', trip); }
  }

  function estSoc() {
    const s = trip.soc[trip.soc.length - 1];
    return s.soc - trip.eSinceSoc / car.usableKWh;
  }

  function recalcLive() {
    if (!trip || !plan) return;
    const rem = plan.segs.slice(trip.idx + 1);
    const remKm = rem.length ? plan.totalKm - plan.segs[trip.idx].km : 0;
    const soc = estSoc();
    const avgV = trip.speeds.length ? trip.speeds.reduce((a, b) => a + b.v, 0) / trip.speeds.length * 3.6 : 0;
    $('dRem').textContent = remKm.toFixed(0) + ' km';
    if (!rem.length) return;
    const cur = Math.min(140, Math.max(60, avgV || plan.speed));
    const eCur = EV.tripEnergy(car, rem, cur);
    const arr = soc - eCur.kWh / car.usableKWh;
    $('dArr').textContent = arr < 0 ? 'Yetmez' : pct(arr); $('dArr').className = 'big ' + socClass(arr);
    $('dArrNote').textContent = (arr < 0 ? `şarjsız ${Math.round(-arr * 100)}% eksik · ` : '') + `ort. ${Math.round(cur)} km/s ile · şimdi ~${pct(soc)}`;
    // önerilen: rezervle şarjsız varabilen en yüksek hız; yoksa toplam süresi en kısa
    const opts = [];
    for (let s = 80; s <= 130; s += 5) opts.push(s);
    const sims = opts.map(s => EV.simulate(car, rem, s, soc, plan.reserve));
    const direct = sims.filter(r => r.feasible && !r.stops.length);
    let rec, note = '';
    if (direct.length) { rec = direct[direct.length - 1]; note = 'şarjsız varış ' + pct(rec.arriveSoc); }
    else { rec = pickBest(sims); if (rec) note = rec.stops.length + ' durak, ' + Math.round(rec.chargeMin) + ' dk şarj'; }
    $('dRec').innerHTML = rec ? rec.cruiseKmh + ' <span class="mut">km/s</span>' : '–';
    if (rec && rec.stops.length) {
      const s = rec.stops[0];
      $('dNext').innerHTML = `Sonraki şarj: <b>~${Math.round(s.km)} km sonra</b>, oraya ~${pct(s.arriveSoc)} ile varırsınız → ${pct(s.targetSoc)}'e şarj (${Math.round(s.minutes)} dk). ${note}`;
    } else $('dNext').textContent = rec ? 'Şarj durağı gerekmiyor · ' + note : 'Rezerv korunarak varılamıyor';
    let h = '<tr><th>Hız</th><th>Şarjsız varış</th><th>Durak</th><th>Kalan süre</th></tr>';
    SPEEDS.forEach(s => {
      const e = EV.tripEnergy(car, rem, s), a = soc - e.kWh / car.usableKWh, r = EV.simulate(car, rem, s, soc, plan.reserve);
      h += `<tr${rec && rec.cruiseKmh === s ? ' class="best"' : ''}><td>${s}</td><td class="${socClass(a)}">${a < 0 ? 'yetmez' : pct(a)}</td><td>${r.feasible ? r.stops.length : '–'}</td><td>${r.feasible ? hm(r.totalH) : '–'}</td></tr>`;
    });
    $('liveTable').innerHTML = h;
  }

  // şarj % girişi + öğrenme
  function saveSoc(val) {
    if (!trip) { toast('Önce sürüşü başlatın'); return; }
    const s = val / 100; if (!(s >= 0 && s <= 1)) { toast('0–100 arası girin'); return; }
    const prev = trip.soc[trip.soc.length - 1];
    let info = '';
    if (s > prev.soc + 0.02) {
      info = 'Şarj algılandı, ölçüm yeniden başladı.';
    } else {
      const actual = (prev.soc - s) * car.usableKWh, model = trip.eSinceSoc;
      const kmSince = trip.km - prev.km;
      if (model > 3 && kmSince > 10 && actual > 0) {
        const raw = model / car.calib, ratio = actual / raw;
        car.calib = Math.min(1.5, Math.max(0.7, 0.6 * car.calib + 0.4 * ratio));
        store.set('car', car);
        info = `Gerçek ${actual.toFixed(1)} kWh, model ${model.toFixed(1)} kWh → düzeltme katsayısı ${car.calib.toFixed(2)}`;
      } else info = 'Kaydedildi (öğrenme için en az ~15 km arayla girin).';
    }
    trip.soc.push({ t: Date.now(), soc: s, km: trip.km, eModel: trip.eModel });
    trip.eSinceSoc = 0;
    store.set('activeTrip', trip);
    $('socInfo').textContent = info; $('socIn').value = '';
    recalcLive();
  }
  $('socSave').onclick = () => saveSoc(+$('socIn').value);
  (function quick() {
    const q = $('socQuick');
    [-5, -1, 1, 5].forEach(d => { const b = document.createElement('button'); b.textContent = (d > 0 ? '+' : '') + d; b.onclick = () => {
      const base = +$('socIn').value || (trip ? Math.round(estSoc() * 100) : 80); $('socIn').value = Math.max(0, Math.min(100, base + d)); }; q.appendChild(b); });
  })();

  // ---------- kayıtlar ----------
  function summarize(t) {
    let used = 0, usedKm = 0;
    for (let i = 1; i < t.soc.length; i++) { const a = t.soc[i - 1], b = t.soc[i]; if (b.soc <= a.soc) { used += (a.soc - b.soc) * car.usableKWh; usedKm += b.km - a.km; } }
    const hrs = ((t.end || Date.now()) - t.start) / 3.6e6;
    return { id: t.id, start: t.start, from: t.from, to: t.to, km: t.km, hrs, kWh100: usedKm > 5 ? used / usedKm * 100 : null, calib: car.calib, nSoc: t.soc.length };
  }
  function renderLogs() {
    const trips = store.get('trips', []), box = $('tripList');
    if (!trips.length) { box.textContent = 'Henüz kayıt yok.'; return; }
    box.innerHTML = '';
    trips.forEach(s => {
      const d = document.createElement('div'); d.className = 'stop'; d.style.borderLeftColor = 'var(--acc)';
      d.innerHTML = `<b>${new Date(s.start).toLocaleString('tr-TR')}</b><br>${s.from} → ${s.to}<br>${s.km.toFixed(0)} km · ${hm(s.hrs)}${s.kWh100 ? ' · gerçek ' + s.kWh100.toFixed(1) + ' kWh/100' : ''} · katsayı ${s.calib.toFixed(2)}`;
      const r = document.createElement('div'); r.className = 'row';
      const ex = document.createElement('button'); ex.className = 'sec'; ex.textContent = 'CSV paylaş'; ex.onclick = () => exportTrip(s.id);
      const del = document.createElement('button'); del.className = 'sec'; del.textContent = 'Sil'; del.onclick = () => {
        if (del.dataset.ok) { store.set('trips', store.get('trips', []).filter(x => x.id !== s.id)); store.del('trip_' + s.id); renderLogs(); }
        else { del.dataset.ok = 1; del.textContent = 'Emin misiniz?'; del.className = 'bad'; } };
      r.append(ex, del); d.appendChild(r); box.appendChild(d);
    });
  }
  async function exportTrip(id) {
    const t = store.get('trip_' + id, null); if (!t) { toast('Kayıt bulunamadı'); return; }
    let csv = 'zaman,enlem,boylam,rakim_m,hiz_kmh,dogruluk_m\n' + t.pts.map(p => [new Date(p[0]).toISOString()].concat(p.slice(1)).join(',')).join('\n');
    csv += '\n\nzaman,sarj_yuzde,km,model_kWh\n' + t.soc.map(s => [new Date(s.t).toISOString(), Math.round(s.soc * 100), s.km.toFixed(2), s.eModel.toFixed(2)].join(',')).join('\n');
    const name = 'ev-surus-' + new Date(t.start).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.csv';
    const file = new File([csv], name, { type: 'text/csv' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- ayarlar ----------
  const FIELDS = [['usableKWh', 'Net batarya (kWh)'], ['massKg', 'Boş ağırlık (kg)'], ['payloadKg', 'Yolcu+yük (kg)'], ['cda', 'CdA (m²)'], ['crr', 'Yuvarlanma dir. Crr'],
    ['driveEff', 'Sürüş verimi'], ['regenEff', 'Rekuperasyon verimi'], ['auxKW', 'Klima/yan tüketim (kW)'], ['maxDcKW', 'Maks. DC şarj (kW)'], ['calib', 'Öğrenilen katsayı']];
  function renderCarForm() {
    $('carName').textContent = car.name;
    $('carForm').innerHTML = FIELDS.map(([k, l]) => `<div><label>${l}</label><input id="car_${k}" type="number" step="any" inputmode="decimal" value="${car[k]}"></div>`).join('');
  }
  $('saveCar').onclick = () => { FIELDS.forEach(([k]) => { const v = parseFloat($('car_' + k).value); if (isFinite(v)) car[k] = v; }); store.set('car', car); toast('Kaydedildi'); if (plan) renderPlan(); };
  $('resetCar').onclick = () => { car = Object.assign({}, EV.DEFAULT_CAR); store.set('car', car); renderCarForm(); toast('Varsayılan değerler yüklendi'); };

  // ---------- açılış ----------
  $('carName').textContent = car.name;
  if (plan) { $('startSoc').value = Math.round(plan.startSoc * 100); $('reserve').value = Math.round(plan.reserve * 100); $('from').value = plan.from.name; $('to').value = plan.to.name; picked.from = plan.from; picked.to = plan.to; renderPlan(); }
  const act = store.get('activeTrip', null);
  if (act && plan) { trip = act; toast('Yarım kalan sürüş devam ediyor'); startWatch(); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
