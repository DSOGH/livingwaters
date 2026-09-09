// Register Service Worker for offline PWA capabilities
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

// IndexedDB Setup for permanent data storage
let db;
const request = indexedDB.open("ProWorkOrders", 1);
request.onupgradeneeded = e => {
  db = e.target.result;
  db.createObjectStore("orders", { keyPath: "id", autoIncrement: true });
};
request.onsuccess = e => { 
  db = e.target.result; 
  loadHistory(); 
};

// Check for API key on load and populate settings
document.addEventListener("DOMContentLoaded", () => {
  const savedKey = localStorage.getItem('GEMINI_KEY');
  if (savedKey) {
    document.getElementById('apiKeyInput').value = savedKey;
  }
});

function toggleSettings() {
  document.getElementById('settingsCard').classList.toggle('hidden');
}

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    alert("Please enter a valid key.");
    return;
  }
  localStorage.setItem('GEMINI_KEY', key);
  alert("API Key saved permanently on this device!");
  toggleSettings();
}

async function processImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const key = localStorage.getItem('GEMINI_KEY');
  if (!key) {
    alert("Please add your Gemini API key in Settings first.");
    toggleSettings();
    return;
  }

  document.getElementById('statusMsg').classList.remove('hidden');
  
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = error => reject(error);
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
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64 } }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    const jsonResponse = await res.json();

    // NEW: Proper Error Handling
    if (jsonResponse.error) {
      throw new Error(jsonResponse.error.message || "Invalid API Key or API Error.");
    }

    if (!jsonResponse.candidates || jsonResponse.candidates.length === 0) {
      throw new Error("No data returned. Please try taking a clearer photo.");
    }

    const data = JSON.parse(jsonResponse.candidates[0].content.parts[0].text);
    populateForm(data);
    
  } catch (err) {
    alert("Scan failed: " + err.message);
  } finally {
    document.getElementById('statusMsg').classList.add('hidden');
    event.target.value = ''; // Reset camera input
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
  
  // Package up all the data
  const parts = [];
  document.querySelectorAll('#partsBody tr').forEach(tr => {
    parts.push({
      qty: tr.children[0].firstElementChild.value,
      desc: tr.children[1].firstElementChild.value,
      amount: tr.children[2].firstElementChild.value
    });
  });

  const labor = [];
  document.querySelectorAll('#laborBody tr').forEach(tr => {
    labor.push({
      desc: tr.children[0].firstElementChild.value,
      amount: tr.children[1].firstElementChild.value
    });
  });

  const record = {
    date: document.getElementById('f_date').value,
    phone: document.getElementById('f_phone').value,
    name: document.getElementById('f_name').value,
    address: document.getElementById('f_address').value,
    tax: document.getElementById('f_tax').value,
    trip: document.getElementById('f_trip').value,
    parts: parts,
    labor: labor,
    total: document.getElementById('f_grand_total').value,
    timestamp: new Date().getTime()
  };

  // Save securely to IndexedDB
  const tx = db.transaction("orders", "readwrite");
  tx.objectStore("orders").add(record);
  tx.oncomplete = () => {
    document.getElementById('editorCard').classList.add('hidden');
    alert("Work order saved successfully!");
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
      const displayDate = v.date ? v.date : new Date(v.timestamp).toLocaleDateString();
      list.innerHTML += `<div class="record">
        <div>
          <strong>${v.name || 'Unknown Customer'}</strong><br>
          <small style="color: var(--muted);">${displayDate} • ${v.address}</small>
        </div>
        <div style="text-align:right; color:#10b981; font-weight:bold;">$${v.total || '0.00'}</div>
      </div>`;
      cursor.continue();
    }
  };
}

function exportCSV() {
  const tx = db.transaction("orders", "readonly");
  tx.objectStore("orders").getAll().onsuccess = e => {
    const records = e.target.result;
    if (!records.length) return alert("No records to export.");
    
    let csv = "ID,Date,Name,Phone,Address,Tax,Trip_Fee,Grand_Total,Type,Qty,Description,Amount\n";
    
    records.forEach(r => {
      // Add Parts
      if (r.parts) {
        r.parts.forEach(p => {
          csv += `"${r.id}","${r.date}","${r.name}","${r.phone}","${r.address}","${r.tax}","${r.trip}","${r.total}","Part","${p.qty}","${p.desc}","${p.amount}"\n`;
        });
      }
      // Add Labor
      if (r.labor) {
        r.labor.forEach(l => {
          csv += `"${r.id}","${r.date}","${r.name}","${r.phone}","${r.address}","${r.tax}","${r.trip}","${r.total}","Labor","","${l.desc}","${l.amount}"\n`;
        });
      }
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `work_orders_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };
}
