// Register Service Worker for offline PWA capabilities
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

// IndexedDB Setup
let db;
const request = indexedDB.open("ProWorkOrders", 1);
request.onupgradeneeded = e => {
  db = e.target.result;
  db.createObjectStore("orders", { keyPath: "id", autoIncrement: true });
};
request.onsuccess = e => { db = e.target.result; loadHistory(); };

function toggleSettings() {
  document.getElementById('settingsCard').classList.toggle('hidden');
  document.getElementById('apiKeyInput').value = localStorage.getItem('GEMINI_KEY') || '';
}

function saveApiKey() {
  localStorage.setItem('GEMINI_KEY', document.getElementById('apiKeyInput').value.trim());
  toggleSettings();
}

async function processImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const key = localStorage.getItem('GEMINI_KEY');
  if (!key) return alert("Add Gemini API key in settings first.");

  document.getElementById('statusMsg').classList.remove('hidden');
  
  try {
    const base64 = await new Promise(r => {
      const reader = new FileReader();
      reader.onload = () => r(reader.result.split(',')[1]);
      reader.readAsDataURL(file);
    });

    const prompt = `Analyze this pool/spa work order. Extract data to strict JSON matching this schema:
    {
      "date": "", "phone": "", "name": "", "address": "",
      "parts": [{"qty": "", "desc": "", "amount": 0}],
      "labor": [{"desc": "", "amount": 0}],
      "tax": 0, "trip": 0
    }
    Format amounts as numbers. Do not calculate totals, just extract what is written.`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64 } }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    const data = JSON.parse((await res.json()).candidates[0].content.parts[0].text);
    populateForm(data);
  } catch (err) {
    alert("Scan failed: " + err);
  } finally {
    document.getElementById('statusMsg').classList.add('hidden');
    event.target.value = '';
  }
}

function populateForm(data) {
  document.getElementById('f_date').value = data.date || '';
  document.getElementById('f_phone').value = data.phone || '';
  document.getElementById('f_name').value = data.name || '';
  document.getElementById('f_address').value = data.address || '';
  document.getElementById('f_tax').value = data.tax || 0;
  document.getElementById('f_trip').value = data.trip || 0;

  document.getElementById('partsBody').innerHTML = '';
  (data.parts || []).forEach(p => addPartRow(p.qty, p.desc, p.amount));
  
  document.getElementById('laborBody').innerHTML = '';
  (data.labor || []).forEach(l => addLaborRow(l.desc, l.amount));

  calculateMath();
  document.getElementById('editorCard').classList.remove('hidden');
}

function addPartRow(q='', d='', a='') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" value="${q}"></td>
    <td><input type="text" value="${d}"></td>
    <td><input type="number" step="0.01" value="${a}" class="part-amt" oninput="calculateMath()"></td>`;
  document.getElementById('partsBody').appendChild(tr);
}

function addLaborRow(d='', a='') {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" value="${d}"></td>
    <td><input type="number" step="0.01" value="${a}" class="labor-amt" oninput="calculateMath()"></td>`;
  document.getElementById('laborBody').appendChild(tr);
}

function calculateMath() {
  let pTotal = 0, lTotal = 0;
  document.querySelectorAll('.part-amt').forEach(el => pTotal += parseFloat(el.value || 0));
  document.querySelectorAll('.labor-amt').forEach(el => lTotal += parseFloat(el.value || 0));
  
  const tax = parseFloat(document.getElementById('f_tax').value || 0);
  const trip = parseFloat(document.getElementById('f_trip').value || 0);
  
  document.getElementById('f_tot_materials').value = pTotal.toFixed(2);
  document.getElementById('f_tot_labor').value = lTotal.toFixed(2);
  document.getElementById('f_grand_total').value = (pTotal + lTotal + tax + trip).toFixed(2);
}

function saveRecord(e) {
  e.preventDefault();
  
  const record = {
    date: document.getElementById('f_date').value,
    name: document.getElementById('f_name').value,
    address: document.getElementById('f_address').value,
    total: document.getElementById('f_grand_total').value,
    timestamp: new Date().getTime()
  };

  const tx = db.transaction("orders", "readwrite");
  tx.objectStore("orders").add(record);
  tx.oncomplete = () => {
    document.getElementById('editorCard').classList.add('hidden');
    loadHistory();
  };
}

function loadHistory() {
  const list = document.getElementById('savedList');
  list.innerHTML = '';
  db.transaction("orders").objectStore("orders").openCursor(null, "prev").onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      const v = cursor.value;
      list.innerHTML += `<div class="record">
        <div><strong>${v.name || 'Unknown'}</strong><br><small>${v.address}</small></div>
        <div style="text-align:right; color:#10b981; font-weight:bold;">$${v.total}</div>
      </div>`;
      cursor.continue();
    }
  };
}

function exportCSV() {
  // Logic to pull from IndexedDB and trigger CSV download
  alert("Export triggered! (Connect to a full CSV generator here)");
}
