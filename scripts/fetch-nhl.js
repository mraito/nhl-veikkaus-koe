// NHL-datan hakuskripti — ajetaan GitHub Actionissa
// Testivaihe: haetaan päättyneen kauden 2025–26 dataa rakenteen todentamiseksi.
const fs = require('fs');
const path = require('path');

// ===== ASETUKSET =====
const TEST_MODE = true;             // true = haetaan viime kauden dataa testiksi
const TEST_DATE = '2026-01-31';     // testipäivä (sarjataulukko + tulokset)
const SEASON = '20252026';          // pörssien kausi testimoodissa
// =====================

const API = 'https://api-web.nhle.com/v1';
const HEADERS = { 'User-Agent': 'nhl-veikkaus-koe/1.0 (kaveriporukan veikkaussovellus; GitHub Action)' };

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

(async () => {
  const date = TEST_MODE ? TEST_DATE : new Date().toISOString().slice(0, 10);
  console.log('Haetaan NHL-data, päivä: ' + date + (TEST_MODE ? ' (TESTIMOODI)' : ''));

  // 1) Sarjataulukko
  save('standings.json', await getJSON(API + '/standings/' + date));

  // 2) Päivän ottelutulokset (kaikki ottelut, ml. ratkaisutapa REG/OT/SO)
  save('scores.json', await getJSON(API + '/score/' + date));

  // 3) Pistepörssi + maalipörssi top 10
  const skatersUrl = TEST_MODE
    ? API + '/skater-stats-leaders/' + SEASON + '/2?categories=points,goals&limit=10'
    : API + '/skater-stats-leaders/current?categories=points,goals&limit=10';
  save('leaders.json', await getJSON(skatersUrl));

  // 4) Maalivahtipörssi (nollapelit, voitot)
  const goaliesUrl = TEST_MODE
    ? API + '/goalie-stats-leaders/' + SEASON + '/2?categories=shutouts,wins&limit=10'
    : API + '/goalie-stats-leaders/current?categories=shutouts,wins&limit=10';
  save('goalies.json', await getJSON(goaliesUrl));

  // 5) Ajon metatiedot
  save('meta.json', { haettu: new Date().toISOString(), paiva: date, testimoodi: TEST_MODE });

  console.log('Valmis!');
})().catch(e => { console.error('VIRHE:', e.message); process.exit(1); });
