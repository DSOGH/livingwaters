if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

let db;
let currentEditId = null; // Tracks if we are editing an existing record

const request = indexedDB.open("ProWorkOrders", 2); // Bumped version for new schema
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
  currentEditId = null; // Reset edit state for a new scan
  
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
    1. Intelligently separate physical parts from labor. For example, if a line says "New Liner, install $8000", classify it based on the primary cost (likely a part) or split it if prices are distinct.
    2. "written_total" MUST be the exact final grand total written on the paper, regardless of the math. If missing, return 0.
    3. Format all amounts as standard numbers.`;

    // Updated to 2.5 Flash for reliability
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

  // If paper total exists and doesn't match our math, ask for a reason
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
  if (!reason) return alert("Please enter a reason for the mismatch.");
  closeDiscrepancyModal();
  executeFinalSave(reason);
}

function closeDiscrepancyModal() {
  document.getElementById('discrepancyModal').classList.add('hidden');
}

function cancelEdit() {
  document.getElementById('editorCard').classList.add('hidden');
  currentEditId = null;
}

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
    paper_total: document.getElementById('f_paper_total').value,
    discrepancy_reason: discrepancyReason,
    parts: parts,
    labor: labor,
    total: document.getElementById('f_grand_total').value,
    timestamp: new Date().getTime()
  };

  const tx = db.transaction("orders", "readwrite");
  const store = tx.objectStore("orders");
  
  if (currentEditId) {
    record.id = currentEditId; // Keep the original ID
    store.put(record);
  } else {
    store.add(record);
  }

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
      
      let warnIcon = v.discrepancy_reason ? `<span title="Total Mismatch: ${v.discrepancy_reason}" style="color: #ef4444; font-size:1rem;">⚠️</span>` : '';

      list.innerHTML += `
      <div class="record">
        <div>
          <strong style="font-size: 1.05rem;">${v.name || 'Unknown Customer'}</strong> ${warnIcon}<br>
          <small style="color: var(--muted);">${displayDate} • ${v.address}</small><br>
          <strong style="color: var(--success); font-size: 0.9rem;">$${v.total || '0.00'}</strong>
        </div>
        <button class="record-btn" onclick="editOrder(${v.id})">Edit</button>
      </div>`;
      cursor.continue();
    }
  };
}

function editOrder(id) {
  const tx = db.transaction("orders", "readonly");
  tx.objectStore("orders").get(id).onsuccess = e => {
    const record = e.target.result;
    if (record) {
      currentEditId = record.id;
      // Map data to the old format the form expects
      populateForm({
        date: record.date, phone: record.phone, name: record.name, address: record.address,
        notes: record.notes, tax: record.tax, trip: record.trip, written_total: record.paper_total,
        parts: record.parts, labor: record.labor
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };
}

// Master/Detail CSV Export
function exportCSV() {
  const tx = db.transaction("orders", "readonly");
  tx.objectStore("orders").getAll().onsuccess = e => {
    const records = e.target.result;
    if (!records.length) return alert("No records to export.");
    
    // Clean headers - Row 1 is Work Order summary, Rows below are items
    let csv = "ID,Date,Customer_Name,Phone,Address,Notes,Tax,Trip_Fee,Grand_Total,Mismatch_Reason\n";
    
    records.forEach(r => {
      // Escape commas in text fields
      const safeName = `"${(r.name || '').replace(/"/g, '""')}"`;
      const safeAddr = `"${(r.address || '').replace(/"/g, '""')}"`;
      const safeNotes = `"${(r.notes || '').replace(/"/g, '""')}"`;
      const safeReason = `"${(r.discrepancy_reason || '').replace(/"/g, '""')}"`;

      // 1. Output the Master Header Row for this Order
      csv += `${r.id},${r.date},${safeName},${r.phone},${safeAddr},${safeNotes},${r.tax},${r.trip},${r.total},${safeReason}\n`;
      
      // 2. Add an indent header for items
      csv += `,,,Type,Qty,Description,Amount,,,\n`;

      // 3. Loop Parts
      if (r.parts) {
        r.parts.forEach(p => {
          if(p.desc || p.amount > 0) {
            const safeDesc = `"${(p.desc || '').replace(/"/g, '""')}"`;
            csv += `,,,Part,${p.qty},${safeDesc},${p.amount},,,\n`;
          }
        });
      }
      
      // 4. Loop Labor
      if (r.labor) {
        r.labor.forEach(l => {
          if(l.desc || l.amount > 0) {
            const safeDesc = `"${(l.desc || '').replace(/"/g, '""')}"`;
            csv += `,,,Labor,,${safeDesc},${l.amount},,,\n`;
          }
        });
      }
      // Blank row to separate orders visually
      csv += `\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `work_orders_pro_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };
}
