// EV enerji modeli — fiziksel model + şarj eğrisi + strateji simülasyonu
// Tarayıcıda global "EV" olarak, Node'da module.exports olarak çalışır.
(function (root) {
  const G = 9.81;

  const DEFAULT_CAR = {
    name: 'Mercedes EQA 250+ (2025)',
    usableKWh: 70.5,
    massKg: 2045,       // boş ağırlık
    payloadKg: 100,     // sürücü + yük
    cda: 0.69,          // Cd 0.28 × A 2.47 m²
    crr: 0.0095,
    driveEff: 0.90,     // batarya → tekerlek
    regenEff: 0.65,     // tekerlek → batarya (rekuperasyon)
    auxKW: 0.8,         // klima/ısıtma + elektronik
    maxDcKW: 100,
    calib: 1.0,         // gerçek sürüşle öğrenilen düzeltme katsayısı
    maxGrade: 0.07      // tünel/viyadük yükselti hatalarına karşı eğim sınırı
  };

  // EQA 250+ DC şarj eğrisi (kW, SoC 0-1) — 30.10.2026 Akyazı şarjıyla uyumlu (%18→%95 ≈ 52 dk)
  function chargePowerKW(soc, maxKW) {
    let p;
    if (soc < 0.50) p = 95;
    else if (soc < 0.65) p = 80;
    else if (soc < 0.80) p = 60;
    else if (soc < 0.90) p = 40;
    else p = 25;
    return Math.min(p * (maxKW / 100), maxKW);
  }

  function chargeMinutes(fromSoc, toSoc, car) {
    if (toSoc <= fromSoc) return 0;
    let t = 0, s = fromSoc;
    const step = 0.005;
    while (s < toSoc - 1e-9) {
      const ds = Math.min(step, toSoc - s);
      t += (ds * car.usableKWh) / chargePowerKW(s, car.maxDcKW) * 60;
      s += ds;
    }
    return t;
  }

  function airDensity(tempC) {
    return 101325 / (287.05 * (tempC + 273.15));
  }

  // Bir segment için batarya enerjisi (kWh). v m/s, d m, grade = dh/d, headwind m/s
  function segmentKWh(car, v, d, grade, opts) {
    opts = opts || {};
    const m = car.massKg + car.payloadKg;
    const rho = airDensity(opts.tempC != null ? opts.tempC : 15);
    const g = Math.max(-car.maxGrade, Math.min(car.maxGrade, grade || 0));
    const crr = car.crr * (opts.wet ? 1.25 : 1);
    const va = Math.max(0, v + (opts.headwind || 0));
    const F = 0.5 * rho * car.cda * va * va + m * G * crr + m * G * g;
    const wheelJ = F * d;
    const battJ = wheelJ >= 0 ? wheelJ / car.driveEff : wheelJ * car.regenEff;
    const auxJ = car.auxKW * 1000 * (v > 0.5 ? d / v : 0);
    return ((battJ + auxJ) / 3.6e6) * car.calib;
  }

  // Rota segmentleri: [{d, grade, maxV (m/s, kent içi sınır veya null), tempC, headwind, wet, km}]
  function segSpeed(seg, cruiseKmh) {
    const cruise = cruiseKmh / 3.6;
    return seg.maxV ? Math.min(cruise, seg.maxV) : cruise;
  }

  // Sabit hızla tüm rotanın enerji ve süresi
  function tripEnergy(car, segs, cruiseKmh) {
    let e = 0, t = 0;
    for (const s of segs) {
      const v = segSpeed(s, cruiseKmh);
      e += segmentKWh(car, v, s.d, s.grade, s);
      t += s.d / v;
    }
    return { kWh: e, hours: t / 3600 };
  }

  // Şarj stratejisi simülasyonu: SoC rezerve düşmeden önce dur, kalan yola yetecek kadar (+marj) şarj et
  function simulate(car, segs, cruiseKmh, startSoc, reserveSoc, opts) {
    opts = opts || {};
    const margin = opts.margin != null ? opts.margin : 0.05;
    const maxTarget = opts.maxTarget != null ? opts.maxTarget : 1.0;
    const stopOverheadMin = opts.stopOverheadMin != null ? opts.stopOverheadMin : 5;
    const n = segs.length;
    const segE = new Array(n), segT = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = segSpeed(segs[i], cruiseKmh);
      segE[i] = segmentKWh(car, v, segs[i].d, segs[i].grade, segs[i]);
      segT[i] = segs[i].d / v;
    }
    // kalan enerji (sondan kümülatif)
    const remE = new Array(n + 1); remE[n] = 0;
    for (let i = n - 1; i >= 0; i--) remE[i] = remE[i + 1] + segE[i];

    let soc = startSoc, driveS = 0, chargeMin = 0, km = 0, minSoc = startSoc;
    const stops = [];
    const trace = [];
    for (let i = 0; i < n; i++) {
      const nextSoc = soc - segE[i] / car.usableKWh;
      if (nextSoc < reserveSoc && soc - remE[i] / car.usableKWh < reserveSoc) {
        // burada dur ve şarj et
        const need = reserveSoc + margin + remE[i] / car.usableKWh;
        const target = Math.min(maxTarget, Math.max(need, soc));
        const mins = chargeMinutes(soc, target, car);
        if (target <= soc + 0.001) return { feasible: false, reason: 'Şarj hedefi yetersiz', stops, km };
        stops.push({ km, segIndex: i, arriveSoc: soc, targetSoc: target, minutes: mins });
        chargeMin += mins + stopOverheadMin;
        soc = target;
      }
      soc -= segE[i] / car.usableKWh;
      if (soc < 0) return { feasible: false, reason: 'Batarya yetmiyor', stops, km };
      driveS += segT[i];
      km += segs[i].d / 1000;
      minSoc = Math.min(minSoc, soc);
      trace.push(soc);
    }
    const totalKWh = remE[0];
    return {
      feasible: true, cruiseKmh, stops, arriveSoc: soc, minSoc,
      driveH: driveS / 3600, chargeMin, totalH: driveS / 3600 + chargeMin / 60,
      kWh: totalKWh, kWhPer100: totalKWh / (km / 100), km, trace
    };
  }

  function compareSpeeds(car, segs, startSoc, reserveSoc, speeds, opts) {
    return speeds.map(v => simulate(car, segs, v, startSoc, reserveSoc, opts));
  }

  // Coğrafi yardımcılar
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const toR = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * toR) * Math.cos(lat2 * toR);
    const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lon2 - lon1) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }

  // Polilinyi sabit aralıklarla yeniden örnekle. coords: [[lon,lat],...], speeds: OSRM m/s (coords-1 uzunluğunda)
  function resample(coords, speeds, stepM) {
    const out = [{ lon: coords[0][0], lat: coords[0][1], vOsrm: speeds ? speeds[0] : null }];
    let carry = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lo1, la1] = coords[i - 1], [lo2, la2] = coords[i];
      const segLen = haversine(la1, lo1, la2, lo2);
      if (segLen === 0) continue;
      let pos = stepM - carry;
      while (pos <= segLen) {
        const f = pos / segLen;
        out.push({ lon: lo1 + (lo2 - lo1) * f, lat: la1 + (la2 - la1) * f, vOsrm: speeds ? speeds[i - 1] : null });
        pos += stepM;
      }
      carry = segLen - (pos - stepM);
    }
    const last = coords[coords.length - 1];
    out.push({ lon: last[0], lat: last[1], vOsrm: speeds ? speeds[speeds.length - 1] : null });
    return out;
  }

  // Örneklenmiş noktalar + yükselti + hava → segmentler
  function buildSegments(pts, weatherAt) {
    // yükselti yumuşatma (5 nokta hareketli ortalama)
    const el = pts.map((p, i) => {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const q = pts[i + k]; if (q && q.ele != null) { s += q.ele; c++; } }
      return c ? s / c : 0;
    });
    const segs = [];
    let km = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = haversine(a.lat, a.lon, b.lat, b.lon);
      if (d < 1) continue;
      const grade = (el[i] - el[i - 1]) / d;
      const brg = bearing(a.lat, a.lon, b.lat, b.lon);
      const w = weatherAt ? weatherAt(b.lat, b.lon) : null;
      let headwind = 0, tempC = 15, wet = false;
      if (w) {
        // rüzgârın geldiği yön (from) ile gidiş yönü arasındaki açı; araç yüksekliği için ×0.7
        const ws = (w.windKmh || 0) / 3.6 * 0.7;
        headwind = ws * Math.cos((w.windDir - brg) * Math.PI / 180);
        tempC = w.tempC; wet = (w.precip || 0) > 0.1;
      }
      const vO = a.vOsrm;
      const maxV = vO != null && vO < 70 / 3.6 ? Math.max(vO * 1.1, 30 / 3.6) : null; // kent içi
      km += d / 1000;
      segs.push({ d, grade, maxV, headwind, tempC, wet, km, lat: b.lat, lon: b.lon, ele: el[i] });
    }
    return segs;
  }

  // Charging power yardımcı dışa aktarım
  const api = { DEFAULT_CAR, chargePowerKW, chargeMinutes, segmentKWh, tripEnergy, simulate, compareSpeeds,
    haversine, bearing, resample, buildSegments, airDensity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EV = api;
})(typeof self !== 'undefined' ? self : this);
