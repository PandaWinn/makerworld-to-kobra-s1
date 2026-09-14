// Extension settings page — in-browser conversion (no external service required)
//
// Internal development-build switch.
//
// This is unrelated to Chrome's extension developer mode.
// Set it to false before creating a public release build.
const ENABLE_KS1_FAULT_SIMULATION = false;

const DEFAULTS = {
  printProfileMode:      'preserve',
  forcedProfileId:       '0.20mm-standard',
  customPrinterProfileId: KS1_CUSTOM_PRINTER_STANDARD_ID,
  orcaCustomPrinterProfileId: KS1_CUSTOM_PRINTER_STANDARD_ID,
  orcaCompatibility:    false,
  filamentPresetMode:    'preserve',
  forceExcludeObject:    true,
  forceBrimOff:          true,
  autoFixOrganicVariableLayer: true,
  fixMultiPlatePositioning: true,
  forceDownloadFilename:   false,
  afterConvert:          'download',
  debugReport:           true,
  deepDebugReport:       false,
  smartProcessMerge:    true,
  strictProcessMerge:   false,

  ks1TestFault:           'none',
};

let customPrinterProfiles = {};
let orcaCustomPrinterProfiles = {};
let pendingPrinterProfileFiles = [];

// ── Small storage helpers ─────────────────────────────────────────────────────

function getSyncStorage(defaults) {
  return new Promise(resolve => chrome.storage.sync.get(defaults, resolve));
}

function setSyncStorage(values) {
  return new Promise(resolve => chrome.storage.sync.set(values, resolve));
}

function getLocalStorage(defaults) {
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

function setLocalStorage(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function setStatus(text, isError = false) {
  const status = document.getElementById('saveStatus');
  if (!status) return;

  status.textContent = text;
  status.style.color = isError ? '#ff7675' : '#4caf50';

  if (text) {
    setTimeout(() => {
      status.textContent = '';
      status.style.color = '#4caf50';
    }, 3000);
  }
}

// ── Print profile section ─────────────────────────────────────────────

async function loadProfiles(savedForcedProfileId) {
  const loading = document.getElementById('profilesLoading');
  const select  = document.getElementById('forcedProfileId');

  try {
    const profiles = await fetch(chrome.runtime.getURL('assets/profiles.json')).then(r => r.json());

    select.replaceChildren();

    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.display;
      if (p.id === savedForcedProfileId) opt.selected = true;
      select.appendChild(opt);
    });

    if (!select.value && profiles.length) select.value = profiles[0].id;

    loading.style.display = 'none';
    select.style.display  = 'block';
  } catch (err) {
    loading.textContent = 'Could not load profiles.';
    console.error('[KS1 options] profile load failed:', err);
  }
}

function updatePrintProfileUi() {
  const forceRadio = document.getElementById('printProfileModeForce');
  const select = document.getElementById('forcedProfileId');

  if (!forceRadio || !select) return;

  select.disabled = !forceRadio.checked;
}

// ── Custom printer profile section ────────────────────────────────────────────

async function loadCustomPrinterProfiles() {
  const stored = await getLocalStorage({
    [KS1_CUSTOM_PRINTER_PROFILE_STORAGE_KEY]: {},
    [KS1_ORCA_CUSTOM_PRINTER_PROFILE_STORAGE_KEY]: {},
  });

  // Existing installations keep using the old key for Anycubic Slicer Next.
  customPrinterProfiles =
    stored[KS1_CUSTOM_PRINTER_PROFILE_STORAGE_KEY] || {};

  orcaCustomPrinterProfiles =
    stored[KS1_ORCA_CUSTOM_PRINTER_PROFILE_STORAGE_KEY] || {};
}

function formatCustomPrinterProfileDate(value) {
  if (!value) return 'unknown';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString();
}

function createProfileInfoRow(labelText, valueNodeOrText) {
  const row = document.createElement('div');
  row.className = 'profile-info-row';

  const label = document.createElement('strong');
  label.textContent = labelText;

  const value = document.createElement('span');

  if (valueNodeOrText instanceof Node) {
    value.appendChild(valueNodeOrText);
  } else {
    value.textContent = String(valueNodeOrText ?? '');
  }

  row.append(label, value);
  return row;
}

function createChangedSettingsDetails(changedSettings) {
  if (!changedSettings.length) {
    return document.createTextNode('None');
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent =
    `${changedSettings.length} setting${changedSettings.length === 1 ? '' : 's'}`;

  const list = document.createElement('ul');
  list.style.margin = '6px 0 0 16px';
  list.style.padding = '0';

  [...changedSettings]
    .sort((a, b) => String(a).localeCompare(String(b)))
    .forEach((key) => {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = String(key);
      item.appendChild(code);
      list.appendChild(item);
    });

  details.append(summary, list);
  return details;
}

function renderCustomPrinterProfileInfo(profile, infoId) {
  const info = document.getElementById(infoId);
  if (!info) return;

  info.replaceChildren();

  if (!profile) {
    info.style.display = 'none';
    return;
  }

  info.style.display = 'block';

  const changedSettings =
    profile.overrideKeys?.length
      ? profile.overrideKeys
      : Object.keys(profile.overrides || {});

  info.append(
    createProfileInfoRow('Name', profile.displayName || profile.id || ''),
    createProfileInfoRow('Based on', profile.inheritedFrom || 'unknown'),
    createProfileInfoRow('Imported', formatCustomPrinterProfileDate(profile.importedAt)),
    createProfileInfoRow('Changed settings', createChangedSettingsDetails(changedSettings)),
    createProfileInfoRow('Source', 'manual import')
  );
}

function renderCustomPrinterProfileSelect({
  profileMap,
  selectId,
  deleteButtonId,
  infoId,
  savedId = KS1_CUSTOM_PRINTER_STANDARD_ID,
}) {
  const select = document.getElementById(selectId);
  const deleteBtn = document.getElementById(deleteButtonId);

  if (!select) return;

  select.replaceChildren();

  const standard = document.createElement('option');
  standard.value = KS1_CUSTOM_PRINTER_STANDARD_ID;
  standard.textContent = 'Standard KS1 profile';
  select.appendChild(standard);

  for (const profile of buildCustomPrinterProfileSelectRows(profileMap)) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent =
      `${profile.displayName} (${profile.overrideCount} overrides)`;
    select.appendChild(option);
  }

  select.value = profileMap[savedId]
    ? savedId
    : KS1_CUSTOM_PRINTER_STANDARD_ID;

  if (deleteBtn) {
    deleteBtn.disabled =
      select.value === KS1_CUSTOM_PRINTER_STANDARD_ID;
  }

  renderCustomPrinterProfileInfo(
    profileMap[select.value] || null,
    infoId
  );
}

function renderBothPrinterProfileSelects(saved = {}) {
  renderCustomPrinterProfileSelect({
    profileMap: customPrinterProfiles,
    selectId: 'customPrinterProfileId',
    deleteButtonId: 'deleteCustomPrinterProfileBtn',
    infoId: 'customPrinterProfileInfo',
    savedId:
      saved.customPrinterProfileId ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,
  });

  renderCustomPrinterProfileSelect({
    profileMap: orcaCustomPrinterProfiles,
    selectId: 'orcaCustomPrinterProfileId',
    deleteButtonId: 'deleteOrcaCustomPrinterProfileBtn',
    infoId: 'orcaCustomPrinterProfileInfo',
    savedId:
      saved.orcaCustomPrinterProfileId ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,
  });
}

function updatePrinterProfileUi() {
  const enabled =
    document.getElementById('orcaCompatibility')?.checked === true;

  const cards = document.getElementById('printerProfileCards');
  const snorcaCard = document.getElementById('snorcaPrinterProfileCard');
  const orcaCard = document.getElementById('orcaPrinterProfileCard');

  if (!cards || !snorcaCard || !orcaCard) return;

  const activeCard = enabled ? orcaCard : snorcaCard;
  const inactiveCard = enabled ? snorcaCard : orcaCard;

  cards.prepend(activeCard);
  cards.append(inactiveCard);

  activeCard.classList.remove('is-inactive');
  inactiveCard.classList.add('is-inactive');

  activeCard.setAttribute('aria-disabled', 'false');
  inactiveCard.setAttribute('aria-disabled', 'true');

  activeCard.querySelectorAll('select, button').forEach(element => {
    element.disabled = false;
  });

  inactiveCard.querySelectorAll('select, button').forEach(element => {
    element.disabled = true;
  });
}

async function saveCustomPrinterProfiles() {
  await setLocalStorage({
    [KS1_CUSTOM_PRINTER_PROFILE_STORAGE_KEY]: customPrinterProfiles,
    [KS1_ORCA_CUSTOM_PRINTER_PROFILE_STORAGE_KEY]: orcaCustomPrinterProfiles,
  });
}

function openPrinterProfileTargetDialog(fileList) {
  pendingPrinterProfileFiles = Array.from(fileList || []);
  if (!pendingPrinterProfileFiles.length) return;

  const dialog = document.getElementById('printerProfileTargetDialog');
  if (!dialog) return;

  dialog.showModal();
}

async function importCustomPrinterProfileFiles(fileList, target) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const targetMap =
    target === 'orca'
      ? orcaCustomPrinterProfiles
      : customPrinterProfiles;

  let imported = 0;
  const errors = [];
  let latestId = KS1_CUSTOM_PRINTER_STANDARD_ID;

  for (const file of files) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const profile = normalizeCustomPrinterProfileJson(json, file.name);

      profile.sourceMode = 'manual';
      profile.targetSlicer = target === 'orca' ? 'orca' : 'snorca';

      targetMap[profile.id] = profile;
      latestId = profile.id;
      imported++;
    } catch (error) {
      errors.push(`${file.name}: ${error.message || error}`);
    }
  }

  await saveCustomPrinterProfiles();

  const currentSaved = {
    customPrinterProfileId:
      document.getElementById('customPrinterProfileId')?.value ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,

    orcaCustomPrinterProfileId:
      document.getElementById('orcaCustomPrinterProfileId')?.value ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,
  };

  if (imported) {
    if (target === 'orca') {
      currentSaved.orcaCustomPrinterProfileId = latestId;
    } else {
      currentSaved.customPrinterProfileId = latestId;
    }
  }

  renderBothPrinterProfileSelects(currentSaved);
  updatePrinterProfileUi();

  if (errors.length) {
    console.warn('[KS1 options] custom printer profile import errors:', errors);
    setStatus(`Imported ${imported}, failed ${errors.length}. See console.`, true);
  } else {
    setStatus(`Imported ${imported} custom printer profile${imported === 1 ? '' : 's'} ✓`);
  }
}

async function deleteSelectedCustomPrinterProfile(target) {
  const isOrca = target === 'orca';
  const selectId = isOrca
    ? 'orcaCustomPrinterProfileId'
    : 'customPrinterProfileId';

  const select = document.getElementById(selectId);
  if (!select || select.value === KS1_CUSTOM_PRINTER_STANDARD_ID) return;

  const profileMap = isOrca
    ? orcaCustomPrinterProfiles
    : customPrinterProfiles;

  delete profileMap[select.value];
  await saveCustomPrinterProfiles();

  const saved = {
    customPrinterProfileId:
      document.getElementById('customPrinterProfileId')?.value ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,

    orcaCustomPrinterProfileId:
      document.getElementById('orcaCustomPrinterProfileId')?.value ||
      KS1_CUSTOM_PRINTER_STANDARD_ID,
  };

  if (isOrca) {
    saved.orcaCustomPrinterProfileId = KS1_CUSTOM_PRINTER_STANDARD_ID;
  } else {
    saved.customPrinterProfileId = KS1_CUSTOM_PRINTER_STANDARD_ID;
  }

  renderBothPrinterProfileSelects(saved);
  updatePrinterProfileUi();

  await setSyncStorage(
    isOrca
      ? { orcaCustomPrinterProfileId: KS1_CUSTOM_PRINTER_STANDARD_ID }
      : { customPrinterProfileId: KS1_CUSTOM_PRINTER_STANDARD_ID }
  );

  setStatus('Custom printer profile deleted ✓');
}

// ── Save settings ─────────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', async () => {
  const settings = {
    printProfileMode:      document.getElementById('printProfileModeForce')?.checked ? 'force' : 'preserve',
    forcedProfileId:       document.getElementById('forcedProfileId')?.value || '0.20mm-standard',
    customPrinterProfileId: document.getElementById('customPrinterProfileId')?.value || KS1_CUSTOM_PRINTER_STANDARD_ID,
    orcaCustomPrinterProfileId: document.getElementById('orcaCustomPrinterProfileId')?.value || KS1_CUSTOM_PRINTER_STANDARD_ID,
    orcaCompatibility:    document.getElementById('orcaCompatibility')?.checked ?? false,
    filamentPresetMode:    document.getElementById('filamentPresetMode')?.value || 'preserve',
    forceExcludeObject:    document.getElementById('forceExcludeObject')?.checked ?? true,
    forceBrimOff:          document.getElementById('forceBrimOff')?.checked ?? true,
    autoFixOrganicVariableLayer: document.getElementById('autoFixOrganicVariableLayer')?.checked ?? true,
    fixMultiPlatePositioning: document.getElementById('fixMultiPlatePositioning')?.checked ?? true,
    forceDownloadFilename: !chrome.runtime.getURL('').startsWith('moz-extension://') && (document.getElementById('forceDownloadFilename')?.checked === true),
    afterConvert:         document.getElementById('afterConvertOpen')?.checked ? 'open' : 'download',
    debugReport:           document.getElementById('debugReport')?.checked ?? true,
    deepDebugReport:       document.getElementById('deepDebugReport')?.checked ?? false,
    smartProcessMerge:     document.getElementById('smartProcessMerge')?.checked ?? true,
    strictProcessMerge:    document.getElementById('strictProcessMerge')?.checked ?? false,
    ks1TestFault:           ENABLE_KS1_FAULT_SIMULATION
      ? document.getElementById('ks1TestFault')?.value || 'none'
      : 'none',
  };

  await setSyncStorage(settings);
  setStatus('Saved ✓');
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('importCustomPrinterProfileBtn')?.addEventListener('click', () => {
  document.getElementById('customPrinterProfileFiles')?.click();
});

document.getElementById('customPrinterProfileFiles')?.addEventListener('change', (event) => {
  openPrinterProfileTargetDialog(event.target.files);
  event.target.value = '';
});

document.getElementById('cancelPrinterProfileImportBtn')?.addEventListener('click', () => {
  pendingPrinterProfileFiles = [];
  document.getElementById('printerProfileTargetDialog')?.close();
});

document.getElementById('confirmPrinterProfileImportBtn')?.addEventListener('click', async () => {
  const target =
    document.querySelector('input[name="printerProfileTarget"]:checked')?.value ||
    'snorca';

  const files = pendingPrinterProfileFiles;
  pendingPrinterProfileFiles = [];

  document.getElementById('printerProfileTargetDialog')?.close();
  await importCustomPrinterProfileFiles(files, target);
});

document.getElementById('deleteCustomPrinterProfileBtn')?.addEventListener('click', () => {
  deleteSelectedCustomPrinterProfile('snorca');
});

document.getElementById('deleteOrcaCustomPrinterProfileBtn')?.addEventListener('click', () => {
  deleteSelectedCustomPrinterProfile('orca');
});

document.getElementById('customPrinterProfileId')?.addEventListener('change', (event) => {
  renderCustomPrinterProfileSelect({
    profileMap: customPrinterProfiles,
    selectId: 'customPrinterProfileId',
    deleteButtonId: 'deleteCustomPrinterProfileBtn',
    infoId: 'customPrinterProfileInfo',
    savedId: event.target.value,
  });
  updatePrinterProfileUi();
});

document.getElementById('orcaCustomPrinterProfileId')?.addEventListener('change', (event) => {
  renderCustomPrinterProfileSelect({
    profileMap: orcaCustomPrinterProfiles,
    selectId: 'orcaCustomPrinterProfileId',
    deleteButtonId: 'deleteOrcaCustomPrinterProfileBtn',
    infoId: 'orcaCustomPrinterProfileInfo',
    savedId: event.target.value,
  });
  updatePrinterProfileUi();
});

document.getElementById('orcaCompatibility')?.addEventListener('change', updatePrinterProfileUi);
document.getElementById('printProfileModePreserve')?.addEventListener('change', updatePrintProfileUi);
document.getElementById('printProfileModeForce')?.addEventListener('change', updatePrintProfileUi);

(async function initOptionsPage() {
  const s = await getSyncStorage(DEFAULTS);
  const printProfileMode = s.printProfileMode || 'preserve';

  const faultSimulationSection =
    document.getElementById(
      'ks1FaultSimulationSection'
    );

  const testFaultSelect =
    document.getElementById(
      'ks1TestFault'
    );

  if (ENABLE_KS1_FAULT_SIMULATION === true) {
    if (faultSimulationSection) {
      faultSimulationSection.style.display =
        'block';
    }

    if (testFaultSelect) {
      testFaultSelect.value =
        s.ks1TestFault || 'none';

      // Unknown or removed fault ids must never remain selected.
      if (!testFaultSelect.value) {
        testFaultSelect.value =
          'none';
      }
    }
  } else {
    if (faultSimulationSection) {
      faultSimulationSection.style.display =
        'none';
    }

    // Remove a value that may remain from a local development build.
    if (
      s.ks1TestFault &&
      s.ks1TestFault !== 'none'
    ) {
      await setSyncStorage({
        ks1TestFault:
          'none',
      });

      s.ks1TestFault =
        'none';
    }
  }

  document.getElementById('printProfileModePreserve').checked =
    printProfileMode !== 'force';

  document.getElementById('printProfileModeForce').checked =
    printProfileMode === 'force';

  document.getElementById('orcaCompatibility').checked =
    s.orcaCompatibility === true;

  document.getElementById('filamentPresetMode').value =
    s.filamentPresetMode || 'preserve';

  document.getElementById('forceExcludeObject').checked =
    s.forceExcludeObject;

  document.getElementById('forceBrimOff').checked =
    s.forceBrimOff;

  document.getElementById('autoFixOrganicVariableLayer').checked =
    s.autoFixOrganicVariableLayer;

  document.getElementById('fixMultiPlatePositioning').checked =
    s.fixMultiPlatePositioning;

  const forceDownloadFilenameCheckbox =
    document.getElementById(
      'forceDownloadFilename'
    );

  const isFirefox =
    chrome.runtime
      .getURL('')
      .startsWith(
        'moz-extension://'
      );

  if (forceDownloadFilenameCheckbox) {
    forceDownloadFilenameCheckbox.checked =
      !isFirefox &&
      s.forceDownloadFilename === true;

    forceDownloadFilenameCheckbox.disabled =
      isFirefox;

    if (isFirefox) {
      forceDownloadFilenameCheckbox.checked =
        false;
    }
  }
    
  document.getElementById('debugReport').checked = s.debugReport;
  document.getElementById('deepDebugReport').checked = s.deepDebugReport;
  document.getElementById('smartProcessMerge').checked = s.smartProcessMerge;
  document.getElementById('strictProcessMerge').checked = s.strictProcessMerge;

  document.getElementById('afterConvertDownload').checked =
    (s.afterConvert || 'download') !== 'open';

  document.getElementById('afterConvertOpen').checked =
    (s.afterConvert || 'download') === 'open';

  document.getElementById('checkBridgeBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('bridgeStatus');

    if (status) status.textContent = 'Checking…';

    try {
      const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'ks1_bridge_ping' }, reply => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }

          resolve(reply || { ok: false, error: 'No response' });
        });
      });

      if (status) {
        if (response?.ok === true) {
          status.textContent =
            response.slicerFound === true
              ? 'Helper found, Slicer Next detected ✓'
              : 'Helper found, but Slicer Next was not detected';
        } else if (response?.hostMissing === true) {
          status.textContent =
            'Helper not installed — run native_host/install.sh';
        } else {
          status.textContent =
            'Helper check failed: ' + (response?.error || 'unknown error');
        }
      }
    } catch (error) {
      if (status) status.textContent = 'Helper check failed';
    }
  });

  await loadProfiles(s.forcedProfileId || '0.20mm-standard');
  updatePrintProfileUi();

  await loadCustomPrinterProfiles();
  renderBothPrinterProfileSelects(s);
  updatePrinterProfileUi();
})();
