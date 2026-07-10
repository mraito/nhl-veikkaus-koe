// NHL-datan hakuskripti v2 — ajetaan GitHub Actionissa
// Uutta v2:ssa: joukkueiden rosterit + otteluohjelma
const fs = require('fs');
const path = require('path');

// ===== ASETUKSET =====
const TEST_MODE = true;             // true = haetaan päättyneen kauden dataa testiksi
const TEST_DATE = '2026-01-31';     // testipäivä (sarjataulukko + tulokset)
const SEASON = '20252026';          // kausi testimoodissa (tuotannossa: '20262027')
// =====================

const API = 'https://api-web.nhle.com/v1';
const HEADERS = { 'User-Agent': 'nhl-veikkaus-koe/2.0 (kaveriporukan veikkaussovellus; GitHub Action)' };

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

function save(name, data) {
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
  console.log('Tallennettu data/' + name);
}

// Tiivistä rosteri: vain veikkauksen tarvitsemat kentät
function tiivistaRosteri(abbrev, r) {
  const map = (lista, pos) => (lista || []).map(p => ({
    id: p.id,
    nimi: p.firstName.default + ' ' + p.lastName.default,
    pos: pos,                       // H = hyökkääjä, P = puolustaja, MV = maalivahti
    numero: p.sweaterNumber || null,
    kuva: p.headshot
  }));
  return {
    joukkue: abbrev,
    pelaajat: map(r.forwards, 'H').concat(map(r.defensemen, 'P'), map(r.goalies, 'MV'))
  };
}

(async () => {
  const date = TEST_MODE ? TEST_DATE : new Date().toISOString().slice(0, 10);
  console.log('Haetaan NHL-data, päivä: ' + date + (TEST_MODE ? ' (TESTIMOODI)' : ''));

  // 1) Sarjataulukko
  const standings = await getJSON(API + '/standings/' + date);
  save('standings.json', standings);

  // 2) Päivän ottelutulokset
  save('scores.json', await getJSON(API + '/score/' + date));

  // 3) Pistepörssi + maalipörssi top 10
  const skatersUrl = TEST_MODE
    ? API + '/skater-stats-leaders/' + SEASON + '/2?categories=points,goals&limit=10'
    : API + '/skater-stats-leaders/current?categories=points,goals&limit=10';
  save('leaders.json', await getJSON(skatersUrl));

  // 4) Maalivahtipörssi
  const goaliesUrl = TEST_MODE
    ? API + '/goalie-stats-leaders/' + SEASON + '/2?categories=shutouts,wins&limit=10'
    : API + '/goalie-stats-leaders/current?categories=shutouts,wins&limit=10';
  save('goalies.json', await getJSON(goaliesUrl));

  // 5) UUTTA: Rosterit kaikilta 32 joukkueelta (sarjataulukosta saadaan lyhenteet)
  const joukkueet = standings.standings.map(t => t.teamAbbrev.default).sort();
  console.log('Haetaan rosterit: ' + joukkueet.length + ' joukkuetta…');
  const rosterit = {};
  for (const abbrev of joukkueet) {
    const r = TEST_MODE
      ? await getJSON(API + '/roster/' + abbrev + '/' + SEASON)
      : await getJSON(API + '/roster/' + abbrev + '/current');
    rosterit[abbrev] = tiivistaRosteri(abbrev, r);
    await new Promise(r2 => setTimeout(r2, 250)); // kohtelias tahti API:lle
  }
  save('rosters.json', rosterit);

  // 6) UUTTA: Otteluohjelma koko kaudelta (viikko kerrallaan schedule-endpointista
  // olisi raskas → haetaan joukkuekohtaiset kausiohjelmat ja yhdistetään)
  console.log('Haetaan otteluohjelma…');
  const ottelut = {};
  for (const abbrev of joukkueet) {
    const s = await getJSON(API + '/club-schedule-season/' + abbrev + '/' + SEASON);
    (s.games || []).forEach(g => {
      if (g.gameType !== 2) return; // vain runkosarja
      ottelut[g.id] = {
        id: g.id,
        alkaaUTC: g.startTimeUTC,
        koti: g.homeTeam.abbrev,
        vieras: g.awayTeam.abbrev
      };
    });
    await new Promise(r2 => setTimeout(r2, 250));
  }
  const lista = Object.values(ottelut).sort((a, b) => a.alkaaUTC.localeCompare(b.alkaaUTC));
  save('schedule.json', { kausi: SEASON, otteluita: lista.length, ottelut: lista });

  // 7) Ajometa
  save('meta.json', { haettu: new Date().toISOString(), paiva: date, kausi: SEASON, testimoodi: TEST_MODE, versio: 2 });

  console.log('Valmis!');
})().catch(e => { console.error('VIRHE:', e.message); process.exit(1); });
