document.addEventListener('DOMContentLoaded', () => {
  // Ver 3.9.6
  document.getElementById('version-chip').textContent = "Ver. 3.9.6";

  /* ---------------- PWA update ---------------- */
  let newWorker;
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar();
        });
      });
    });
    let refreshing;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      window.location.reload();
      refreshing = true;
    });
  }

  const ann = {
    banner: document.getElementById('announcement-banner'),
    icon: document.getElementById('announcement-icon'),
    text: document.getElementById('announcement-text')
  };
  ann.text.innerHTML = `
      <div class="font-bold mb-2">【保健所からのお知らせ】</div>
      <ul class="list-disc pl-5 space-y-1">
        <li>このアプリはイベント等に出店する臨時飲食店営業者がHACCPの考え方を取り入れた衛生管理を行うための支援ツールです。</li>
        <li>アプリ上で入力した内容は端末（PCやスマートフォン）にのみ保存され、第3者が閲覧することはできません。</li>
        <li class="font-bold">データはブラウザに自動保存されますが、ブラウザのサイトデータ（Cookie等）を消去すると記録も消去されます。定期的にExcel出力やデータ引継ぎ機能からバックアップを取ってください。</li>
      </ul>`;
  function showUpdateBar() {
    ann.banner.style.backgroundColor = '#fef9c3';
    ann.banner.style.borderColor = '#fde047';
    ann.icon.style.color = '#ca8a04';
    ann.text.style.color = '#a16207';
    ann.text.innerHTML = `
        <span class="font-bold">【更新のお知らせ】</span>
        新しいバージョンが利用可能です。
        <button id="trigger-update-btn" class="btn btn-sky"
          style="padding:.25rem .75rem;margin-left:.5rem;vertical-align:middle;">今すぐ更新</button>`;
    document.getElementById('trigger-update-btn').addEventListener('click', () => {
      newWorker.postMessage({action: 'skipWaiting'});
    });
  }

  /* ---------------- Elements & State ---------------- */
  let currentClassifiedMenus = {1: [], 2: [], 3: []};
  let allRecords = [];
  let generalHygieneDetails = {};
  let criticalControlDetails = {};
  const allSections = [
    document.getElementById('step1'),
    document.getElementById('step2'),
    document.getElementById('generate-plan-btn-container'),
    document.getElementById('classification-review-section'),
    document.getElementById('plan-output')
  ];
  const [restaurantNameInput, planPreparerInput, planDateInput, menuItemsInput] =
    ['restaurant-name', 'plan-preparer', 'plan-date', 'menu-items']
      .map(id => document.getElementById(id));
  const [
    reviewList,
    generalHygienePointsContainer,
    criticalPointsContent,
    recordTableHead,
    recordTableBody
  ] = [
    'review-list',
    'general-hygiene-points',
    'critical-points-content',
    'record-table-head',
    'record-table-body'
  ].map(id => document.getElementById(id));
  const [confirmModal, promptModal, datePromptModal, reviewModal] =
    ['confirm-modal', 'prompt-modal', 'date-prompt-modal', 'review-modal']
      .map(id => document.getElementById(id));

  /* ---------------- CSV & Utils ---------------- */
  let CSV_MENU_DICT = [], GENERAL_HYGIENE_CSV = [], CRITICAL_CONTROL_CSV = [];

  async function fetchCsv(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(path + ' ' + res.status);
    let text = await res.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const rows = [];
    const len = text.length;
    let i = 0, field = '', row = [], quote = false;
    while (i < len) {
      const c = text[i];
      if (quote) {
        if (c === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            quote = false;
            i++;
          }
        } else {
          field += c;
          i++;
        }
      } else {
        if (c === '"') {
          quote = true;
          i++;
        } else if (c === ',') {
          row.push(field);
          field = '';
          i++;
        } else if (c === '\r') {
          i++;
        } else if (c === '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
          i++;
        } else {
          field += c;
          i++;
        }
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    const headers = rows[0].map(v => v.trim());
    return rows.slice(1)
      .filter(r => r.length && r.some(v => v.trim() !== ''))
      .map(r => {
        const o = {};
        headers.forEach((k, j) => o[k] = (r[j] ?? '').trim());
        return o;
      });
  }

  async function loadResources() {
    try {
      [CSV_MENU_DICT, GENERAL_HYGIENE_CSV, CRITICAL_CONTROL_CSV] = await Promise.all([
        fetchCsv('./menu_dict.csv'),
        fetchCsv('./general_hygiene.csv'),
        fetchCsv('./critical_control.csv')
      ]);
    } catch (e) {
      console.error(e);
    }
    loadPlanData();
  }

  function normalize(n) {
    return n.normalize('NFKC')
      .replace(/[ァ-ン]/g, s => String.fromCharCode(s.charCodeAt(0) - 0x60))
      .toLowerCase().trim();
  }

  function getMenuInfo(n) {
    const norm = normalize(n);
    for (const r of CSV_MENU_DICT) {
      const base = r.menu_name;
      const syns = (r.synonyms || '').split(';');
      const candidates = [base, ...syns];
      for (const v of candidates) {
        if (!v) continue;
        const nv = normalize(v);
        const minLen = Math.max(norm.length, nv.length) * 0.7 + 1;
        if (norm.slice(0, minLen) === nv.slice(0, minLen)) {
          return {g: (parseInt(r.group, 10) || 3), a: r.alert?.trim()};
        }
      }
    }
    return {g: 3, a: null};
  }

  function autoResize(el) {
    if (el.tagName !== 'TEXTAREA') return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  /* ---------------- UI Helpers ---------------- */
  function showConfirm(title, message, btnText = 'OK') {
    return new Promise(resolve => {
      confirmModal.querySelector('#confirm-title').textContent = title;
      confirmModal.querySelector('#confirm-message').textContent = message;
      document.getElementById('modal-confirm-btn').textContent = btnText;
      document.getElementById('modal-confirm-btn').onclick = () => {
        confirmModal.classList.add('hidden');
        resolve(true);
      };
      document.getElementById('modal-cancel-btn').onclick = () => {
        confirmModal.classList.add('hidden');
        resolve(false);
      };
      confirmModal.classList.remove('hidden');
    });
  }

  function showPrompt(title, label, def = "") {
    return new Promise(resolve => {
      promptModal.querySelector('#prompt-title').textContent = title;
      promptModal.querySelector('#prompt-label').textContent = label;
      const input = document.getElementById('prompt-input');
      input.value = def;
      document.getElementById('prompt-confirm-btn').onclick = () => {
        promptModal.classList.add('hidden');
        resolve(input.value);
      };
      document.getElementById('prompt-cancel-btn').onclick = () => {
        promptModal.classList.add('hidden');
        resolve(null);
      };
      promptModal.classList.remove('hidden');
      input.focus();
    });
  }

  function showDatePrompt(title, label, def = "") {
    return new Promise(resolve => {
      datePromptModal.querySelector('#date-prompt-title').textContent = title;
      datePromptModal.querySelector('#date-prompt-label').textContent = label;
      const input = document.getElementById('date-prompt-input');
      input.value = def;
      document.getElementById('date-prompt-confirm-btn').onclick = () => {
        datePromptModal.classList.add('hidden');
        resolve(input.value);
      };
      document.getElementById('date-prompt-cancel-btn').onclick = () => {
        datePromptModal.classList.add('hidden');
        resolve(null);
      };
      datePromptModal.classList.remove('hidden');
      input.focus();
    });
  }

  /* ---------------- Core Logic ---------------- */
  function showSection(which) {
    allSections.forEach(s => s.classList.add('hidden'));
    if (which === 'init') {
      allSections[0].classList.remove('hidden');
      allSections[1].classList.remove('hidden');
      allSections[2].classList.remove('hidden');
    } else if (which === 'review') {
      allSections[3].classList.remove('hidden');
    } else if (which === 'plan') {
      allSections[4].classList.remove('hidden');
    }
  }

  function savePlanData() {
    GENERAL_HYGIENE_CSV.forEach(r => {
      const id = r.id || r.item_name;
      generalHygieneDetails[id] = {
        when: document.getElementById(`gh-when-${id}`)?.value || '',
        response: document.getElementById(`gh-response-${id}`)?.value || '',
        responsible: document.getElementById(`gh-responsible-${id}`)?.value || ''
      };
    });
    [1, 2, 3].forEach(i => {
      const whenVal = document.querySelector(`textarea[data-group-num="${i}"][data-field="when"]`)?.value;
      if (whenVal !== undefined) {
        criticalControlDetails[i] = {
          when: whenVal,
          response: document.querySelector(`textarea[data-group-num="${i}"][data-field="response"]`)?.value
        };
      }
    });

    if (
      allRecords.some(r => Object.values(r.records).some(v => v.value === 'bad') && !r.specialNotes?.trim()) &&
      !confirm('⚠️ 特記事項が未記入の不良記録があります。保存しますか？')
    ) return;

    localStorage.setItem('haccpAppPlan_temporary', JSON.stringify({
      restaurantName: restaurantNameInput.value,
      planPreparer: planPreparerInput.value,
      planDate: planDateInput.value,
      menuItemsText: menuItemsInput.value,
      classifiedMenus: currentClassifiedMenus,
      generalHygieneDetails,
      criticalControlDetails
    }));
    alert('保存しました。');
  }

  function loadPlanData() {
    // ① 記録
    allRecords = JSON.parse(localStorage.getItem('haccpAppRecords_temporary') || '[]');
    // ② 計画
    const d = JSON.parse(localStorage.getItem('haccpAppPlan_temporary') || '{}');

    if (d.restaurantName) {
      restaurantNameInput.value = d.restaurantName;
      planPreparerInput.value = d.planPreparer;
      planDateInput.value = d.planDate;
      menuItemsInput.value = d.menuItemsText;
      generalHygieneDetails = d.generalHygieneDetails || {};
      criticalControlDetails = d.criticalControlDetails || {};
      currentClassifiedMenus = d.classifiedMenus || {1: [], 2: [], 3: []};

      if (Object.values(currentClassifiedMenus).some(a => a.length))
        renderPlanAndRecords();
      else
        showSection('init');
    } else {
      planDateInput.value = new Date().toISOString().slice(0, 10);
      showSection('init');
    }
  }

  function renderPlanAndRecords() {
    const isMob = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    ['print-plan-btn', 'print-record-btn', 'print-all-btn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.toggle('hidden', isMob);
    });

    document.getElementById('output-restaurant-name').textContent = restaurantNameInput.value;
    document.getElementById('output-plan-date').textContent = planDateInput.value;
    document.getElementById('output-plan-preparer').textContent = planPreparerInput.value;

    // 一般衛生
    generalHygienePointsContainer.innerHTML = GENERAL_HYGIENE_CSV.map(r => {
      const id = r.id || r.item_name;
      const d = generalHygieneDetails[id] || {};
      return `
          <div>
            <p><strong>${r.item_name}</strong></p>
            <div class="mt-2 pl-4 text-xs text-gray-600 space-y-1">
              <p><strong>【なぜ？】</strong> ${r.why || ''}</p>
              <div>
                <label class="form-label text-xs">【どうやって？】</label>
                <textarea class="form-textarea p-2 editable-plan" rows="1">${r.how || ''}</textarea>
              </div>
            </div>
            <div class="mt-2 pl-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label class="form-label text-xs">【いつ実施】</label>
                <textarea id="gh-when-${id}" class="form-textarea p-2 editable-plan" rows="1">
${d.when || r.default_when || ''}</textarea>
              </div>
              <div>
                <label class="form-label text-xs">【担当者】</label>
                <textarea id="gh-responsible-${id}" class="form-textarea p-2 editable-plan" rows="1">
${d.responsible || r.default_responsible || ''}</textarea>
              </div>
              <div>
                <label class="form-label text-xs">【対応】</label>
                <textarea id="gh-response-${id}" class="form-textarea p-2 editable-plan" rows="1">
${d.response || r.default_response || ''}</textarea>
              </div>
            </div>
          </div>`;
    }).join('');

    // 重要管理
    criticalPointsContent.innerHTML = [1, 2, 3].filter(i => currentClassifiedMenus[i].length).map(i => {
      const r = CRITICAL_CONTROL_CSV.find(c => parseInt(c.group, 10) === i) || {};
      const d = criticalControlDetails[i] || {};
      return `
          <div class="border border-gray-200 p-4 rounded-lg">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;">
              <h3 class="text-xl font-semibold text-gray-800">
                <span class="inline-block bg-sky-100 text-sky-800 rounded-full px-3 py-1 text-sm font-semibold mr-2">
                  ${r.title || ''}
                </span>
              </h3>
              <p class="text-sm text-gray-600">
                <strong>例：</strong>${currentClassifiedMenus[i].join(', ')}
              </p>
            </div>
            <p class="text-sm text-gray-500 mt-1">原則：${r.principle || ''}</p>
            <div class="mt-2 pl-4 text-xs text-gray-600 space-y-1">
              <p><strong>【なぜ？】</strong> ${r.why || ''}</p>
              <div>
                <label class="form-label text-xs">【どうやって？】</label>
                <textarea class="form-textarea p-2 editable-plan" rows="1">${r.how || ''}</textarea>
              </div>
            </div>
            <div class="mt-2 pl-4">
              <label class="form-label text-xs">【いつ実施】</label>
              <textarea data-group-num="${i}" data-field="when" class="form-textarea p-2 editable-plan" rows="1">
${d.when || r.default_when || ''}</textarea>
              <label class="form-label text-xs mt-2">【対応】</label>
              <textarea data-group-num="${i}" data-field="response" class="form-textarea p-2 editable-plan" rows="1">
${d.response || r.default_response || ''}</textarea>
            </div>
          </div>`;
    }).join('');

    document.querySelectorAll('.editable-plan').forEach(autoResize);
    document.getElementById('record-print-header').innerHTML =
      `<p><strong>店名：</strong> ${restaurantNameInput.value}</p>`;
    generateRecordSheet();
    showSection('plan');
  }

  function generateRecordSheet() {
    const sorted = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    // ヘッダ
    recordTableHead.innerHTML = `
        <tr>
          <th rowspan="2">管理項目</th>
          <th rowspan="2">基準／該当メニュー</th>
          ${sorted.map(r => `
            <th>
              <div style="display:flex;flex-direction:column;align-items:center;">
                <input type="date" class="form-input record-date-input mb-1" value="${r.date}" data-id="${r.id}">
                <button class="btn-red delete-record-btn mt-1" data-id="${r.id}"
                  style="width:20px;height:20px;padding:0;font-size:12px;line-height:20px;">×</button>
              </div>
            </th>`).join('')}
        </tr>
        <tr>
          ${sorted.map(r => `
            <th>
              <input type="text" class="form-input event-name-input" value="${r.eventName}"
                    placeholder="イベント名" data-id="${r.id}">
            </th>`).join('')}
        </tr>`;

    const items = [
      {id: 'materialsAndWIP', i: '①原材料受入', c: '品温/異物/期限'},
      {id: 'coolerTemp', i: '②冷蔵庫等温度', c: '適切に冷却'},
      {id: 'crossContamination', i: '③交差汚染防止', c: '器具区別/洗浄'},
      {id: 'equipmentCleaning', i: '④器具等の洗浄', c: '手順通り実施'},
      {id: 'employeeHealth', i: '⑤従事者健康', c: '健康状態良好'},
      {id: 'handwashing', i: '⑥手洗い', c: '手順通り実施'},
      {
        id: 'group1',
        i: `【重】非加熱品${currentClassifiedMenus[1].length ? ` (${currentClassifiedMenus[1].join(', ')})` : ''}`,
        c: '10℃以下保管'
      },
      {
        id: 'group2',
        i: `【重】加熱品${currentClassifiedMenus[2].length ? ` (${currentClassifiedMenus[2].join(', ')})` : ''}`,
        c: '中心部まで加熱'
      },
      {
        id: 'group3',
        i: `【重】物品販売${currentClassifiedMenus[3].length ? ` (${currentClassifiedMenus[3].join(', ')})` : ''}`,
        c: '適切温度保管'
      }
    ];

    recordTableBody.innerHTML =
      items.map(i => {
        const isTempTarget = i.id === 'group1';
        const rowClass = i.id.startsWith('group')
          ? ('record-row-group' +
            (currentClassifiedMenus[parseInt(i.id.slice(-1))]?.length ? ' record-row-group-active' : ''))
          : 'record-row-common';
        return `
            <tr class="${rowClass}" data-item-id="${i.id}">
              <td>${i.i}</td>
              <td>${i.c}</td>
              ${sorted.map(r => {
                const rec = r.records[i.id] || {};
                const v = rec.value || '';
                const t = rec.temp || '';
                return `
                  <td>
                    <div class="record-cell-wrapper">
                      <select class="status-select" data-id="${r.id}" data-item-id="${i.id}"
                        style="background-color:${v === 'good' ? '#22c55e' : (v === 'bad' ? '#ef4444' : '#fff')};
                                color:${v ? '#fff' : '#111'}">
                        <option value="" ${!v ? 'selected' : ''}>未入力</option>
                        <option value="good" ${v === 'good' ? 'selected' : ''}>良好</option>
                        <option value="bad" ${v === 'bad' ? 'selected' : ''}>不良</option>
                      </select>
                      ${isTempTarget ? `
                        <div class="temp-wrapper">
                          <input type="number" step="0.1" class="temp-input"
                            data-id="${r.id}" data-item-id="${i.id}" data-field="temp"
                            placeholder="温度" value="${t || ''}">
                          <span class="temp-unit">℃</span>
                        </div>` : ''}
                    </div>
                  </td>`;
              }).join('')}
            </tr>`;
      }).join('') +
      [{id: 'specialNotes', l: '特記事項'},
        {id: 'reviewNotes', l: '振り返り'},
        {id: 'checkerName', l: 'チェック者'},
        {id: 'confirmerName', l: '確認者'}]
        .map(o => `
          <tr data-item-id="${o.id}">
            <td>${o.l}</td>
            <td></td>
            ${sorted.map(r => {
          if (o.id === 'confirmerName' || o.id === 'checkerName') {
            return `
                  <td>
                    <input type="text" data-id="${r.id}" data-field="${o.id}"
                      class="w-full p-1 bg-transparent temp-input"
                      value="${r[o.id] || ''}">
                  </td>`;
          } else {
            return `
                  <td>
                    <textarea data-id="${r.id}" data-field="${o.id}"
                      class="w-full p-1 bg-transparent temp-input ${r.id}">
${r[o.id] || ''}</textarea>
                  </td>`;
          }
        }).join('')}
          </tr>`).join('');

    recordTableBody.querySelectorAll('.temp-input').forEach(autoResize);

    sorted.forEach(r => {
      if (
        Object.values(r.records).some(v => v.value === 'bad') &&
        !recordTableBody.querySelector(`textarea[data-id="${r.id}"][data-field="specialNotes"]`)?.value.trim()
      ) {
        recordTableBody
          .querySelector(`textarea[data-id="${r.id}"][data-field="specialNotes"]`)
          ?.classList.add('highlight-note');
      }
    });
  }

  /* ---------------- Event Listeners ---------------- */
  document.getElementById('generate-plan-btn').onclick = async () => {
    if (!restaurantNameInput.value.trim() || !planPreparerInput.value.trim() || !planDateInput.value) {
      return showConfirm('エラー', '必須項目を入力してください。');
    }
    const items = menuItemsInput.value.split('\n').map(v => v.trim()).filter(Boolean);
    if (!items.length) return showConfirm('エラー', '品目を入力してください。');

    reviewList.innerHTML = '';
    const alerts = [];
    items.forEach((m, i) => {
      const {g, a} = getMenuInfo(m);
      if (a) alerts.push(`${m}：${a}`);
      reviewList.insertAdjacentHTML('beforeend', `
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 p-3 bg-gray-50 border rounded-lg" data-menu="${m}">
            <span class="sm:col-span-2">${m}</span>
            <select id="gs-${i}" class="form-select">
              ${['非加熱', '加熱', '物品販売'].map((n, j) =>
        `<option value="${j + 1}" ${g === j + 1 ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>`);
    });

    if (alerts.length) {
      await new Promise(resolve => {
        const d = document.createElement('div');
        d.className = 'dialog-overlay';
        d.innerHTML = `
            <div class="dialog-box">
              <h3 class="font-bold">注意</h3>
              <ul class="list-disc ml-5 mt-2">
                ${alerts.map(a => `<li>${a}</li>`).join('')}
              </ul>
              <div class="text-right mt-4">
                <button class="btn btn-sky">OK</button>
              </div>
            </div>`;
        document.body.appendChild(d);
        d.querySelector('button').onclick = () => {
          d.remove();
          resolve();
        };
      });
    }
    showSection('review');
  };

  document.getElementById('confirm-classification-btn').onclick = () => {
    currentClassifiedMenus = {1: [], 2: [], 3: []};
    reviewList.querySelectorAll('[data-menu]').forEach((el, i) => {
      const groupVal = document.getElementById(`gs-${i}`).value;
      currentClassifiedMenus[groupVal].push(el.dataset.menu);
    });
    renderPlanAndRecords();
  };

  document.getElementById('back-to-step2-btn').onclick = () => {
    menuItemsInput.value = Array.from(reviewList.querySelectorAll('[data-menu]'))
      .map(e => e.dataset.menu)
      .join('\n');
    showSection('init');
  };

  document.getElementById('manual-update-btn').onclick = async () => {
    if (!navigator.serviceWorker?.controller) return alert('最新です');
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    if (!reg.waiting) alert('最新です');
  };

  document.getElementById('clear-data-btn-header').onclick = async () => {
    if (await showConfirm('削除', '全データを削除しますか？', '削除')) {
      localStorage.clear();
      location.reload();
    }
  };

  recordTableHead.addEventListener('click', async e => {
    if (e.target.classList.contains('delete-record-btn')) {
      if (await showConfirm('削除', 'この記録を削除しますか？', '削除')) {
        allRecords = allRecords.filter(r => r.id != e.target.dataset.id);
        localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
        generateRecordSheet();
      }
    }
  });

  recordTableHead.addEventListener('change', e => {
    const rec = allRecords.find(r => r.id == e.target.dataset.id);
    if (rec) {
      if (e.target.matches('.record-date-input')) rec.date = e.target.value;
      else rec.eventName = e.target.value;
      localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
    }
  });

  recordTableBody.addEventListener('change', e => {
    if (e.target.matches('.status-select')) {
      const rec = allRecords.find(r => r.id == e.target.dataset.id);
      const v = e.target.value;
      if (!rec.records[e.target.dataset.itemId]) rec.records[e.target.dataset.itemId] = {};
      rec.records[e.target.dataset.itemId].value = v;
      e.target.style.backgroundColor = v === 'good' ? '#22c55e' : (v === 'bad' ? '#ef4444' : '#fff');
      e.target.style.color = v ? '#fff' : '#111';
      localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));

      if (v === 'bad') {
        alert('特記事項を記入してください');
        const note = recordTableBody.querySelector(
          `textarea[data-id="${rec.id}"][data-field="specialNotes"]`);
        note?.classList.add('highlight-note');
        note?.focus();
      } else if (!Object.values(rec.records).some(val => val.value === 'bad')) {
        recordTableBody
          .querySelector(`textarea[data-id="${rec.id}"][data-field="specialNotes"]`)
          ?.classList.remove('highlight-note');
      }
    } else if (e.target.matches('input[data-field="temp"]')) {
      const record = allRecords.find(r => r.id == e.target.dataset.id);
      if (!record.records[e.target.dataset.itemId]) record.records[e.target.dataset.itemId] = {};
      record.records[e.target.dataset.itemId].temp = e.target.value;
      localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
    } else if (e.target.matches('.temp-input')) {
      const rec = allRecords.find(r => r.id == e.target.dataset.id);
      rec[e.target.dataset.field] = e.target.value;
      localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
    }

    // === すべての項目入力完了時に確認者ダイアログを出す ===
    const record = allRecords.find(r => r.id == e.target.dataset.id);
    if (!record) return;
    // 対象の営業日で、すべての「管理項目」が good / bad のいずれかで埋まった？
    const allFilled = ['materialsAndWIP', 'coolerTemp', 'crossContamination',
      'equipmentCleaning', 'employeeHealth', 'handwashing',
      'group1', 'group2', 'group3'
    ].every(key => record.records[key]?.value);

    if (allFilled && !record.confirmerName) {
      setTimeout(async () => {
        const name = await showPrompt('確認者名を入力', '当日の記録を確認した方の氏名を入力してください');
        if (name) {
          record.confirmerName = name;
          localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
          generateRecordSheet();
          alert('確認者名を記録しました。');
        }
      }, 500);
    }
  });

  recordTableBody.addEventListener('input', e => {
    if (e.target.matches('textarea')) {
      autoResize(e.target);
      if (e.target.classList.contains('highlight-note') && e.target.value.trim()) {
        e.target.classList.remove('highlight-note');
      }
    }
    if (e.target.matches('input[data-field="temp"]')) {
      const tempValue = parseFloat(e.target.value);
      const statusSelect = e.target.closest('td').querySelector('.status-select');
      let newStatus = '';

      if (isNaN(tempValue) || e.target.value.trim() === '') {
        newStatus = '';
      } else if (tempValue > 10) {
        newStatus = 'bad';
      } else {
        newStatus = 'good';
      }

      if (statusSelect.value !== newStatus) {
        statusSelect.value = newStatus;
        statusSelect.dispatchEvent(new Event('change', {bubbles: true}));
      }
    }
  });

  /* --- 新しい営業日の記録を追加 --- */
  document.getElementById('add-record-btn').onclick = async () => {
    const date = await showDatePrompt(
      '新しい営業日を追加',
      '営業日を入力してください：',
      new Date().toISOString().slice(0, 10)
    );
    if (!date) return;

    if (allRecords.some(r => r.date === date)) {
      const ok = await showConfirm(
        '確認',
        '同じ営業日の記録が既に存在します。追加しますか？',
        '追加'
      );
      if (!ok) return;
    }

    const baseSorted = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastEventName = baseSorted[0]?.eventName || '';
    const lastChecker = baseSorted[0]?.checkerName || '';

    const eventName = await showPrompt(
      'イベント名を入力',
      'イベントや出店名（例：〇〇祭り・△△会場）',
      lastEventName
    );
    const checkerName = await showPrompt(
      'チェック者名を入力',
      'チェック者名（例：担当者）',
      lastChecker
    );
    if (eventName === null || checkerName === null) return;

    allRecords.push({
      id: Date.now(),
      date,
      eventName: eventName || '未入力',
      records: {},
      specialNotes: '',
      reviewNotes: '',
      checkerName: checkerName || '',
      confirmerName: ''
    });
    localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
    generateRecordSheet();
  };

  /* --- 計画を修正する --- */
  document.getElementById('modify-plan-btn').onclick = async () => {
    if (await showConfirm(
      '計画の修正',
      '現在の計画を修正モードで開きますか？\n※記録データは保持されます。',
      '修正する'
    )) {
      showSection('init');
    }
  };

  /* --- この計画を保存 --- */
  document.getElementById('save-plan-btn').onclick = savePlanData;

  /* --- 全記録をExcel出力 --- */
  document.getElementById('export-excel-btn').onclick = () => {
    if (Object.values(currentClassifiedMenus).every(a => !a.length)) {
      return alert('計画がありません。先に計画を作成してください。');
    }
    const wb = XLSX.utils.book_new();

    // Sheet1: 衛生管理計画
    const planData = [
      ['【衛生管理計画】'],
      ['店名', restaurantNameInput.value],
      ['作成者', planPreparerInput.value],
      ['作成日', planDateInput.value],
      [],
      ['[一般衛生管理]']
    ];
    GENERAL_HYGIENE_CSV.forEach(r => {
      const id = r.id || r.item_name;
      const d = generalHygieneDetails[id] || {};
      planData.push([
        r.item_name,
        'いつ:' + (d.when || r.default_when || ''),
        '誰が:' + (d.responsible || r.default_responsible || ''),
        '対応:' + (d.response || r.default_response || '')
      ]);
    });
    planData.push([], ['[重要管理]']);
    [1, 2, 3].forEach(i => {
      if (currentClassifiedMenus[i].length) {
        const c = CRITICAL_CONTROL_CSV.find(x => parseInt(x.group, 10) === i) || {};
        const d = criticalControlDetails[i] || {};
        planData.push([
          c.title,
          '対象:' + currentClassifiedMenus[i].join(', '),
          'いつ:' + (d.when || c.default_when || ''),
          '対応:' + (d.response || c.default_response || '')
        ]);
      }
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(planData), '衛生管理計画');

    // Sheet2: 衛生管理記録
    const s = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    const d = [
      ['項目', '基準', ...s.map(r => r.date)],
      ['', '', ...s.map(r => r.eventName)]
    ];
    [
      {id: 'materialsAndWIP', i: '①原材料受入', c: '品温/異物/期限'},
      {id: 'coolerTemp', i: '②冷蔵庫等温度', c: '適切に冷却'},
      {id: 'crossContamination', i: '③交差汚染防止', c: '器具区別/洗浄'},
      {id: 'equipmentCleaning', i: '④器具等の洗浄', c: '手順通り実施'},
      {id: 'employeeHealth', i: '⑤従事者健康', c: '健康状態良好'},
      {id: 'handwashing', i: '⑥手洗い', c: '手順通り実施'},
      {id: 'group1', i: '【重】非加熱品', c: '10℃以下保管'},
      {id: 'group2', i: '【重】加熱品', c: '中心部まで加熱'},
      {id: 'group3', i: '【重】物品販売', c: '適切温度保管'}
    ].forEach(i => {
      d.push([
        i.i,
        i.c,
        ...s.map(r => {
          const val = (r.records[i.id] || {});
          const mark = val.value === 'good' ? '✅' : (val.value === 'bad' ? '❌' : '');
          if (i.id === 'group1' && val.temp) {
            return `${mark}(${val.temp}℃)`;
          }
          return mark;
        })
      ]);
    });

    [{id: 'specialNotes', l: '特記事項'},
      {id: 'reviewNotes', l: '振り返り'},
      {id: 'checkerName', l: 'チェック者'},
      {id: 'confirmerName', l: '確認者'}]
      .forEach(o => {
        d.push([o.l, '', ...s.map(r => r[o.id] || '')]);
      });

    const ws = XLSX.utils.aoa_to_sheet(d);
    ws['!cols'] = [{wch: 20}, {wch: 20}, ...Array(s.length).fill({wch: 15})];
    XLSX.utils.book_append_sheet(wb, ws, '衛生管理記録');
    XLSX.writeFile(wb, (restaurantNameInput.value || '衛生管理') + '_記録.xlsx');
  };

  /* --- JSONエクスポート --- */
  document.getElementById('export-json-btn').onclick = () => {
    const planData = localStorage.getItem('haccpAppPlan_temporary');
    const recordData = localStorage.getItem('haccpAppRecords_temporary');
    if (!planData && !recordData) {
      alert('保存されているデータがありません。');
      return;
    }
    const backupData = {
      plan: planData || '{}',
      records: recordData || '[]',
      exportedAt: new Date().toISOString()
    };
    const jsonString = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonString], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `haccp_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert('バックアップファイル (json) をダウンロードしました。\nこのファイルを新しい端末に送って保管してください。');
  };

  /* --- JSONインポート --- */
  document.getElementById('import-json-btn').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      let text;
      try {
        text = await file.text();
      } catch (readError) {
        console.error('File read error:', readError);
        alert('ファイルの読み込みに失敗しました。');
        return;
      }

      let parsedData;
      try {
        parsedData = JSON.parse(text);
      } catch (e) {
        alert('ファイルの読み込みに失敗しました。有効なJSONファイルではありません。');
        return;
      }

      if (typeof parsedData.plan !== 'string' || typeof parsedData.records !== 'string') {
        alert('ファイルの形式が正しくありません。(planまたはrecordsキーが見つかりません)');
        return;
      }

      const confirmed = await showConfirm(
        'データ復元（インポート）',
        '警告：ファイルからデータを復元します。\n現在の計画と記録は【すべて上書き】されます。\n\n本当によろしいですか？',
        '復元する'
      );

      if (confirmed) {
        try {
          JSON.parse(parsedData.plan);
          JSON.parse(parsedData.records);

          localStorage.setItem('haccpAppPlan_temporary', parsedData.plan);
          localStorage.setItem('haccpAppRecords_temporary', parsedData.records);
          alert('データを復元しました。アプリを再読み込みします。');
          location.reload();
        } catch (e) {
          alert('データの形式が無効なため、復元を中止しました。\n(バックアップファイルが破損している可能性があります)\nエラー: ' + e.message);
        }
      }
    };
    input.click();
  };

  /* ---------------- Print Logic ---------------- */
  async function handlePrint(mode) {
    document.body.classList.add(`print-mode-${mode}`);
    if (mode !== 'plan') {
      const originalTable = document.getElementById('record-table');
      if (originalTable) {
        document.querySelectorAll('.split-print-table').forEach(e => e.remove());
        const dateColCount = Array.from(
          originalTable.querySelectorAll('thead tr:first-child th')
        ).length - 2;
        if (dateColCount <= 5) {
          const clone = originalTable.cloneNode(true);
          clone.id = '';
          clone.classList.add('split-print-table');
          originalTable.after(clone);
        } else {
          for (let i = 0; i < dateColCount; i += 5) {
            const clone = originalTable.cloneNode(true);
            clone.id = '';
            clone.classList.add('split-print-table');
            const start = 2 + i;
            const end = Math.min(start + 5, 2 + dateColCount);

            const headRow1 = clone.querySelector('thead tr:nth-child(1)');
            Array.from(headRow1.children).forEach((th, idx) => {
              if (idx >= 2 && (idx < start || idx >= end)) th.remove();
            });
            const headRow2 = clone.querySelector('thead tr:nth-child(2)');
            Array.from(headRow2.children).forEach((th, idx) => {
              const colIndex = 2 + idx;
              if (colIndex < start || colIndex >= end) th.remove();
            });
            clone.querySelectorAll('tbody tr').forEach(tr => {
              Array.from(tr.children).forEach((td, idx) => {
                if (idx >= 2 && (idx < start || idx >= end)) td.remove();
              });
            });
            originalTable.after(clone);
          }
        }
      }
    }

    // 印刷用プレースホルダ
    document.querySelectorAll('textarea, input[type="text"]').forEach(el => {
      if (el.nextElementSibling && el.nextElementSibling.classList.contains('print-replacement')) return;
      const div = document.createElement('div');
      div.className = 'print-replacement';
      div.textContent = el.value;
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.style.position = 'absolute';
      el.after(div);
    });

    await new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );

    const cleanup = () => {
      document.body.classList.remove('print-mode-plan', 'print-mode-record', 'print-mode-all');
      document.querySelectorAll('.split-print-table').forEach(e => e.remove());
      document.querySelectorAll('.print-replacement').forEach(e => e.remove());
      document.querySelectorAll('textarea, input[type="text"]').forEach(el => {
        el.style.opacity = '';
        el.style.pointerEvents = '';
        el.style.position = '';
      });
      window.removeEventListener('afterprint', cleanup);
      document.querySelectorAll('textarea.editable-plan, textarea.temp-input').forEach(autoResize);
    };

    window.addEventListener('afterprint', cleanup);
    setTimeout(() => {
      window.print();
      setTimeout(cleanup, 2000);
    }, 150);
  }

  document.getElementById('print-plan-btn').onclick = () => handlePrint('plan');
  document.getElementById('print-record-btn').onclick = () => handlePrint('record');
  document.getElementById('print-all-btn').onclick = () => handlePrint('all');

  document.getElementById('pdf-output-btn').onclick = async () => {
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
      alert('📄 この後開く画面で、共有メニューから「PDFに保存」または「ファイルに保存」などを選択してください。');
    } else if (!confirm('印刷画面が開きます。送信先で「PDFに保存」を選択してください。続行しますか？')) {
      return;
    }
    await handlePrint('all');
  };

  /* ---------------- Review Feature ---------------- */
  document.getElementById('start-review-btn').onclick = async () => {
    if (!allRecords.length) {
      return alert('記録がありません。先に記録を作成してください。');
    }
    reviewModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };

  document.getElementById('review-cancel-btn').onclick = (e) => {
    e.preventDefault();
    reviewModal.classList.add('hidden');
    document.body.style.overflow = '';
  };

  document.getElementById('review-form').addEventListener('change', (e) => {
    if (e.target.name === 'q1')
      document.getElementById('q1-followup').classList.toggle('hidden', e.target.value === 'yes');
    if (e.target.name === 'q3')
      document.getElementById('q3-followup').classList.toggle('hidden', e.target.value === 'no');
    if (e.target.name === 'q4')
      document.getElementById('q4-followup').classList.toggle('hidden', e.target.value === 'no');
    if (e.target.name === 'q5')
      document.getElementById('q5-followup').classList.toggle('hidden', e.target.value === 'no');
  });

  document.getElementById('review-save-btn').onclick = async (e) => {
    e.preventDefault();
    if (!confirm('この内容で振り返りを記録しますか？\n※最新の記録日の欄に追記されます。')) return;

    const fd = new FormData(document.getElementById('review-form'));
    let text = `【${new Date().toISOString().slice(0, 7)} 月次振り返り】\n`;
    text += `Q1(記録): ${fd.get('q1') === 'yes' ? 'はい' : 'いいえ'}${
      fd.get('q1') === 'no' ? ` →対策: ${fd.get('q1-detail')}` : ''}\n`;
    text += `Q2(問題点): ${fd.get('q2-point') || 'なし'}\n`;
    if (fd.get('q3') === 'yes') {
      text += `Q3(従業員変更): はい →説明:${
        fd.get('q3-explained') === 'yes' ? `済(${fd.get('q3-date')})` : '未'
      }, 理解:${fd.get('q3-understood') === 'yes' ? 'はい' : 'いいえ'}\n`;
    }
    if (fd.get('q4') === 'yes') {
      text += `Q4(メニュー等変更): はい →見直し:${
        fd.get('q4-reviewed') === 'yes' ? `済(${fd.get('q4-date')})` : '未'
      }\n`;
    }
    if (fd.get('q5') === 'yes') {
      text += `Q5(設備変更): はい →見直し:${
        fd.get('q5-reviewed') === 'yes' ? `済(${fd.get('q5-date')})` : '未'
      }\n`;
    }

    const sorted = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
    if (sorted.length > 0) {
      const targetRecord = allRecords.find(r => r.id === sorted[0].id);
      if (targetRecord) {
        targetRecord.reviewNotes = (targetRecord.reviewNotes ? targetRecord.reviewNotes + '\n\n' : '') + text;
        localStorage.setItem('haccpAppRecords_temporary', JSON.stringify(allRecords));
        generateRecordSheet();
        alert('最新の記録日の「振り返り欄」に追記しました。');
        reviewModal.classList.add('hidden');
        document.body.style.overflow = '';
        document.getElementById('review-form').reset();
        document.querySelectorAll('.review-sub-q').forEach(el => el.classList.add('hidden'));
      }
    }
  };

  // 最後にリソース読み込み
  loadResources();
});
