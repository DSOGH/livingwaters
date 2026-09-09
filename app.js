if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

let db;
let currentEditId = null;

const request = indexedDB.open("ProWorkOrders", 2);
request.onupgradeneeded = e => {
  db = e.target.result;
  if (!db.objectStoreNames.contains("orders")) {
    db.createObjectStore("orders", { keyPath: "id", autoIncrement: true });
  }
};
request.onsuccess = e => { db = e.target.result; loadHistory(); };

document.addEventListener("DOMContentLoaded", () => {
  const savedKey = localStorage.getItem('GEMINI_KEY');
  if (savedKey) document.getElementById('apiKeyInput').value = savedKey;
});

function toggleSettings() { document.getElementById('settingsCard').classList.toggle('hidden'); }

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return alert("Please enter a valid key.");
  localStorage.setItem('GEMINI_KEY', key);
  alert("API Key saved!");
  toggleSettings();
}

async function processImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const key = localStorage.getItem('GEMINI_KEY');
  if (!key) return alert("Please add your Gemini API key in Settings first.");

  document.getElementById('statusMsg').classList.remove('hidden');
  currentEditId = null; 
  
  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = error => reject(error);
      reader.readAsDataURL(file);
    });

    const prompt = `Analyze this handwritten pool/spa work order. Extract data to strict JSON matching this schema:
    {
      "date": "", "phone": "", "name": "", "address": "",
      "parts": [{"qty": "", "desc": "", "amount": 0}],
      "labor": [{"desc": "", "amount": 0}],
      "tax": 0, "trip": 0, "written_total": 0, "notes": ""
    }
    CRITICAL RULES:
    1. Intelligently separate physical parts from labor. 
    2. "written_total" MUST be the exact final grand total written on the paper.
    3. Format all amounts as standard numbers.`;

    // Updated Model Parameter to gemini-3.6 per instructions
     const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64 } }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    const jsonResponse = await res.json();
    if (jsonResponse.error) throw new Error(jsonResponse.error.message);
    
    const data = JSON.parse(jsonResponse.candidates[0].content.parts[0].text);
    populateForm(data);
    
  } catch (err) {
    alert("Scan failed: " + err.message);
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
  document.getElementById('f_notes').value = data.notes || '';
  document.getElementById('f_paper_total').value = data.written_total || 0;

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

function handleSaveInitiation(e) {
  e.preventDefault();
  const calcTotal = parseFloat(document.getElementById('f_grand_total').value);
  const paperTotal = parseFloat(document.getElementById('f_paper_total').value);

  if (paperTotal > 0 && Math.abs(calcTotal - paperTotal) > 0.05) {
    document.getElementById('calcTotalDisplay').innerText = calcTotal.toFixed(2);
    document.getElementById('paperTotalDisplay').innerText = paperTotal.toFixed(2);
    document.getElementById('f_discrepancy_reason').value = '';
    document.getElementById('discrepancyModal').classList.remove('hidden');
  } else {
    executeFinalSave();
  }
}

function confirmDiscrepancySave() {
  const reason = document.getElementById('f_discrepancy_reason').value.trim();
  if (!reason) return alert("Required reason for mismatch.");
  document.getElementById('discrepancyModal').classList.add('hidden');
  executeFinalSave(reason);
}

function closeDiscrepancyModal() { document.getElementById('discrepancyModal').classList.add('hidden'); }
function cancelEdit() { document.getElementById('editorCard').classList.add('hidden'); currentEditId = null; }

function executeFinalSave(discrepancyReason = null) {
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
    notes: document.getElementById('f_notes').value,
    tax: document.getElementById('f_tax').value,
    trip: document.getElementById('f_trip').value,
    parts: parts, labor: labor,
    total: document.getElementById('f_grand_total').value,
    materials_total: document.getElementById('f_tot_materials').value,
    labor_total: document.getElementById('f_tot_labor').value,
    timestamp: new Date().getTime()
  };

  const tx = db.transaction("orders", "readwrite");
  const store = tx.objectStore("orders");
  
  if (currentEditId) { record.id = currentEditId; store.put(record); } 
  else { store.add(record); }

  tx.oncomplete = () => {
    document.getElementById('editorCard').classList.add('hidden');
    currentEditId = null;
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
      list.innerHTML += `
      <div class="record">
        <div style="flex: 1;">
          <strong style="font-size: 1.05rem;">${v.name || 'Unknown'}</strong><br>
          <small style="color: var(--muted);">${displayDate} • ${v.address}</small><br>
          <strong style="color: var(--success); font-size: 0.95rem;">$${v.total || '0.00'}</strong>
        </div>
        <div class="record-btn-group">
          <button class="record-btn" onclick="editOrder(${v.id})">Edit</button>
          <button class="record-btn invoice-btn" onclick="generateInvoice(${v.id})">📄 Invoice</button>
        </div>
      </div>`;
      cursor.continue();
    }
  };
}

function editOrder(id) {
  db.transaction("orders", "readonly").objectStore("orders").get(id).onsuccess = e => {
    const record = e.target.result;
    if (record) {
      currentEditId = record.id;
      populateForm(record);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
}

/* =========================================
   INVOICE GENERATION ENGINE
   ========================================= */
function generateInvoice(id) {
  db.transaction("orders", "readonly").objectStore("orders").get(id).onsuccess = e => {
    const data = e.target.result;
    if (!data) return;

    // Populate Top Info
    document.getElementById('inv-date').innerText = data.date || '';
    document.getElementById('inv-phone').innerText = data.phone || '';
    document.getElementById('inv-name').innerText = data.name || '';
    document.getElementById('inv-address').innerText = data.address || '';

    // Populate Parts Table
    const tbody = document.getElementById('inv-parts-body');
    tbody.innerHTML = '';
    let rowCount = 0;
    
    (data.parts || []).forEach(p => {
      if (p.desc || p.amount > 0) {
        tbody.innerHTML += `<tr>
          <td>${p.qty}</td>
          <td class="handwriting">${p.desc}</td>
          <td></td>
          <td>${p.amount}</td>
        </tr>`;
        rowCount++;
      }
    });

    // Add empty rows to keep the layout looking like a full sheet
    while (rowCount < 10) {
      tbody.innerHTML += `<tr><td></td><td></td><td></td><td></td></tr>`;
      rowCount++;
    }

    // Populate Labor
    const laborList = document.getElementById('inv-labor-list');
    laborList.innerHTML = '';
    (data.labor || []).forEach(l => {
      if(l.desc || l.amount > 0) laborList.innerHTML += `<div>${l.desc} - $${l.amount}</div>`;
    });
    if(data.notes) laborList.innerHTML += `<div style="font-size: 12px; margin-top: 10px; color:#555;">Notes: ${data.notes}</div>`;

    // Populate Totals
    document.getElementById('inv-tot-mat').innerText = data.materials_total || '0.00';
    document.getElementById('inv-tax').innerText = data.tax || '0.00';
    document.getElementById('inv-tot-lab').innerText = data.labor_total || '0.00';
    document.getElementById('inv-trip').innerText = data.trip || '0.00';
    document.getElementById('inv-grand').innerText = data.total || '0.00';

    // Trigger Print Window
    window.print();
  };
}

function exportCSV() {
  // Master/Detail Export logic identical to previous version
  const tx = db.transaction("orders", "readonly");
  tx.objectStore("orders").getAll().onsuccess = e => {
    const records = e.target.result;
    let csv = "ID,Date,Customer_Name,Phone,Address,Notes,Tax,Trip_Fee,Grand_Total\n";
    records.forEach(r => {
      csv += `${r.id},${r.date},"${r.name}","${r.phone}","${r.address}","${r.notes}",${r.tax},${r.trip},${r.total}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `living_scanner_export.csv`;
    a.click();
  };
}
