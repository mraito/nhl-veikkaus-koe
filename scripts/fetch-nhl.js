// NHL-datan hakuskripti v3 — GitHub Action
// Uutta v3:ssa: vakiokohteiden tulokset, kuunvaihdesnapshotit, kaikkien pelaajien maalit/nollapelit
const fs = require('fs');
const path = require('path');

// ===== ASETUKSET =====
const TEST_MODE = true;
const TEST_DATE = '2026-01-31';
const SEASON = '20252026';          // tuotannossa: '20262027'
const TEST_CHECKPOINTS = ['2025-10-31', '2025-11-30', '2025-12-31'];
// =====================

const API = 'https://api-web.nhle.com/v1';
const HEADERS = { 'User-Agent': 'nhl-veikkaus-koe/5.0 (kaveriporukan veikkaussovellus; GitHub Action)' };

async function getJSON(url) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.log('Yritys ' + i + '/3 epäonnistui: ' + url + ' (' + e.message + ')');
      if (i === 3) throw e;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}
const nuku = (ms) => new Promise(r => setTimeout(r, ms));
function save(name, data) {
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
  console.log('Tallennettu data/' + name);
}
const onPO = (t) => t.divisionSequence <= 3 || (t.wildcardSequence >= 1 && t.wildcardSequence <= 2);

(async () => {
  const date = TEST_MODE ? TEST_DATE : new Date().toISOString().slice(0, 10);
  console.log('NHL-data v3, päivä: ' + date + (TEST_MODE ? ' (TESTIMOODI)' : ''));

  // 1) Sarjataulukko
  const standings = await getJSON(API + '/standings/' + date);
  save('standings.json', standings);

  // 2) Päivän ottelut
  save('scores.json', await getJSON(API + '/score/' + date));

  // 3-4) Pörssit top 10 (näkymiin)
  const kausiTaiCurrent = (polku, params) => TEST_MODE
    ? API + '/' + polku + '/' + SEASON + '/2?' + params
    : API + '/' + polku + '/current?' + params;
  save('leaders.json', await getJSON(kausiTaiCurrent('skater-stats-leaders', 'categories=points,goals&limit=30')));
  save('goalies.json', await getJSON(kausiTaiCurrent('goalie-stats-leaders', 'categories=shutouts,wins&limit=30')));

  // 5) UUTTA: KAIKKIEN pelaajien maalit + maalivahtien nollapelit (limit=-1 = kaikki)
  console.log('Haetaan pelaajatilastot (kaikki pelaajat)…');
  const kaikkiKentta = await getJSON(kausiTaiCurrent('skater-stats-leaders', 'categories=goals,assists,points&limit=-1'));
  const kaikkiNollat = await getJSON(kausiTaiCurrent('goalie-stats-leaders', 'categories=shutouts&limit=-1'));
  const maalit = {}, syotot = {}, pisteet = {}, nollapelit = {};
  (kaikkiKentta.goals || []).forEach(p => { maalit[p.id] = p.value; });
  (kaikkiKentta.assists || []).forEach(p => { syotot[p.id] = p.value; });
  (kaikkiKentta.points || []).forEach(p => { pisteet[p.id] = p.value; });
  (kaikkiNollat.shutouts || []).forEach(p => { nollapelit[p.id] = p.value; });
  save('playerstats.json', { maalit, syotot, pisteet, nollapelit });
  console.log('Kenttäpelaajia:', Object.keys(maalit).length, '| maalivahteja:', Object.keys(nollapelit).length);

  // Maalivahtipörssi: torjunta-%, GAA, voitot (kategorianimet varmistetaan varapoluilla)
  let mvExtra = null;
  for (const cats of ['savePctg,goalsAgainstAverage,wins', 'savePctg,goalsAgainstAvg,wins', 'savePctg,wins']) {
    try { mvExtra = await getJSON(kausiTaiCurrent('goalie-stats-leaders', 'categories=' + cats + '&limit=30')); break; }
    catch (e) { console.log('MV-kategoriat "' + cats + '" ei kelvannut, kokeillaan seuraavaa…'); }
  }
  if (mvExtra) save('goaliestats.json', mvExtra);
  else console.log('MV-pörssidataa ei saatu — paneeli näyttää ohjeen.');

  // 6) UUTTA: Vakiokohteiden tulokset (lukee data/round1.json:n reposta)
  const roundPolku = path.join(process.cwd(), 'data', 'round1.json');
  if (fs.existsSync(roundPolku)) {
    const round = JSON.parse(fs.readFileSync(roundPolku, 'utf8'));
    const idt = new Set(round.kohteet.map(g => g.id));
    // Kohteiden pelipäivät UTC-datan mukaan (score-endpoint käyttää USA-päivää):
    // haetaan varmuuden vuoksi sekä FI-päivä-1 kattamaan aikaerot → kerätään UTC-päivät suoraan schedulesta
    const schedule = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'schedule.json'), 'utf8'));
    const utcPaivat = new Set();
    schedule.ottelut.forEach(g => { if (idt.has(g.id)) utcPaivat.add(new Date(new Date(g.alkaaUTC).getTime() - 6 * 3600 * 1000).toISOString().slice(0, 10)); }); // NHL:n pelipäivä = UTC - 6 h
    console.log('Haetaan vakiotulokset:', utcPaivat.size, 'pelipäivää…');
    const tulokset = {};
    const dayscores = {};   // kaikki päivien ottelut pistemiehineen (NHL-seuranta)
    for (const pv of Array.from(utcPaivat).sort()) {
      const sc = await getJSON(API + '/score/' + pv);
      const paivanOttelut = [];
      (sc.games || []).forEach(g => {
        if (g.gameOutcome && idt.has(g.id)) {
          tulokset[g.id] = { v: g.awayTeam.score, k: g.homeTeam.score, paattyi: g.gameOutcome.lastPeriodType };
        }
        if (!g.gameOutcome) return;
        // Pistemiehet: maalintekijä 1+0, syöttäjät 0+1
        const pts = {};
        (g.goals || []).forEach(maali => {
          const lisaa = (id, nimi, gg, aa) => {
            if (!id) return;
            const k = String(id);
            if (!pts[k]) pts[k] = { n: nimi, g: 0, a: 0 };
            pts[k].g += gg; pts[k].a += aa;
          };
          lisaa(maali.playerId, maali.name && maali.name.default ? maali.name.default : '', 1, 0);
          (maali.assists || []).forEach(s => lisaa(s.playerId, s.name && s.name.default ? s.name.default : '', 0, 1));
        });
        paivanOttelut.push({
          id: g.id, alkaaUTC: g.startTimeUTC,
          koti: g.homeTeam.abbrev, vieras: g.awayTeam.abbrev,
          v: g.awayTeam.score, k: g.homeTeam.score,
          paattyi: g.gameOutcome.lastPeriodType, pts
        });
      });
      if (paivanOttelut.length) dayscores[pv] = paivanOttelut;
      await nuku(200);
    }
    save('results1.json', { kohteita: idt.size, tuloksia: Object.keys(tulokset).length, tulokset });
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'data', 'dayscores.json'), JSON.stringify(dayscores));
    console.log('Tallennettu data/dayscores.json (' + Object.keys(dayscores).length + ' pelipäivää)');
  } else {
    console.log('data/round1.json puuttuu — ohitetaan vakiotulokset.');
  }

  // 7) UUTTA: Kuunvaihdesnapshotit kuukausipisteisiin
  const cpPaivat = TEST_MODE ? TEST_CHECKPOINTS : (() => {
    // Tuotanto: kauden kuluneet kuunvaihteet loka-maaliskuu
    const nyt = new Date(); const lista = [];
    [[9, 31], [10, 30], [11, 31], [0, 31], [1, 28], [2, 31]].forEach(([kk, pv], i) => {
      const vuosi = kk >= 9 ? 2026 : 2027;   // HUOM: päivitä kausikohtaisesti
      const d = new Date(Date.UTC(vuosi, kk, pv));
      if (d < nyt) lista.push(d.toISOString().slice(0, 10));
    });
    return lista;
  })();
  const checkpoints = {};
  for (const pv of cpPaivat) {
    const st = await getJSON(API + '/standings/' + pv);
    const po = {};
    st.standings.forEach(t => { po[t.teamAbbrev.default] = onPO(t); });
    checkpoints[pv] = po;
    await nuku(200);
  }
  save('checkpoints.json', checkpoints);
  console.log('Snapshotit:', Object.keys(checkpoints).join(', '));

  // 8) Rosterit
  const joukkueet = standings.standings.map(t => t.teamAbbrev.default).sort();
  console.log('Haetaan rosterit…');
  const rosterit = {};
  for (const abbrev of joukkueet) {
    const r = await getJSON(API + '/roster/' + abbrev + '/' + (TEST_MODE ? SEASON : 'current'));
    const map = (lista, pos) => (lista || []).map(p => ({
      id: p.id, nimi: p.firstName.default + ' ' + p.lastName.default, pos,
      numero: p.sweaterNumber || null, kuva: p.headshot, maa: p.birthCountry || null
    }));
    rosterit[abbrev] = { joukkue: abbrev,
      pelaajat: map(r.forwards, 'H').concat(map(r.defensemen, 'P'), map(r.goalies, 'MV')) };
    await nuku(200);
  }
  save('rosters.json', rosterit);

  // 9) Otteluohjelma
  console.log('Haetaan otteluohjelma…');
  const ottelut = {};
  for (const abbrev of joukkueet) {
    const s = await getJSON(API + '/club-schedule-season/' + abbrev + '/' + SEASON);
    (s.games || []).forEach(g => {
      if (g.gameType !== 2) return;
      ottelut[g.id] = { id: g.id, alkaaUTC: g.startTimeUTC, koti: g.homeTeam.abbrev, vieras: g.awayTeam.abbrev };
    });
    await nuku(200);
  }
  const lista = Object.values(ottelut).sort((a, b) => a.alkaaUTC.localeCompare(b.alkaaUTC));
  save('schedule.json', { kausi: SEASON, otteluita: lista.length, ottelut: lista });

  // 10) Meta
  save('meta.json', { haettu: new Date().toISOString(), paiva: date, kausi: SEASON, testimoodi: TEST_MODE, versio: 5 });
  console.log('Valmis!');
})().catch(e => { console.error('VIRHE:', e.message); process.exit(1); });
