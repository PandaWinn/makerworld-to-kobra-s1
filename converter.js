// Main conversion orchestrator for MakerWorld/Bambu 3MF → Snapmaker KS1 3MF.
//
// Keeps the high-level workflow in one place:
// parse source project → build KS1 project → rewrite metadata → write output ZIP.

const TARGET_FILAMENTS = 4;

// -----------------------------------------------------------------------------
// Conversion error and diagnostics foundation
// -----------------------------------------------------------------------------
//
// Tracks each conversion stage, normalizes failures into stable error codes,
// creates copy-ready diagnostics and supports controlled developer fault tests.

const KS1_ERROR_CODES = Object.freeze({
  UNKNOWN: 'KS1-UNKNOWN-001',

  RUNTIME_UNAVAILABLE: 'KS1-RUNTIME-001',
  STORAGE_UNAVAILABLE: 'KS1-RUNTIME-002',

  DOWNLOAD_TRIGGER_FAILED: 'KS1-DL-001',
  DOWNLOAD_INTERCEPT_FAILED: 'KS1-DL-002',
  DOWNLOAD_HTTP_FAILED: 'KS1-DL-003',
  DOWNLOAD_TIMEOUT: 'KS1-DL-004',
  OUTPUT_DOWNLOAD_FAILED: 'KS1-DL-005',

  INPUT_INVALID: 'KS1-INPUT-001',
  ZIP_READ_FAILED: 'KS1-ZIP-001',
  PROJECT_PARSE_FAILED: 'KS1-PARSE-001',
  PROJECT_SETTINGS_MISSING: 'KS1-PARSE-002',

  PROFILE_RESOLUTION_FAILED: 'KS1-PROFILE-001',
  PROFILE_LOAD_FAILED: 'KS1-PROFILE-002',

  PROCESS_MERGE_FAILED: 'KS1-BUILD-001',
  ARRAY_NORMALIZATION_FAILED: 'KS1-BUILD-002',
  FILAMENT_NORMALIZATION_FAILED: 'KS1-BUILD-003',
  COMPATIBILITY_FAILED: 'KS1-BUILD-004',
  PRINTER_PROFILE_FAILED: 'KS1-BUILD-005',
  PROJECT_BUILD_FAILED: 'KS1-BUILD-006',

  METADATA_REWRITE_FAILED: 'KS1-META-001',
  ZIP_WRITE_FAILED: 'KS1-ZIP-002',

  REPORT_FAILED: 'KS1-REPORT-001',
});

const KS1_DIAGNOSTIC_STAGE_STATUS = Object.freeze({
  RUNNING: 'running',
  OK: 'ok',
  FAILED: 'failed',
});

const KS1_DIAGNOSTIC_STAGES = Object.freeze({
  CAPTURE_DOWNLOAD:
    'capture-makerworld-download',

  FETCH_CAPTURED_RESPONSE:
    'fetch-captured-response',

  FETCH_CDN_FILE:
    'fetch-makerworld-cdn-file',

  READ_SETTINGS:
    'read-extension-settings',

  LOAD_PRINTER_PROFILE:
    'load-printer-profile',

  START_OUTPUT_DOWNLOAD:
    'start-output-download',

  INITIALIZE:
    'initialize-conversion',

  COPY_INPUT:
    'copy-input',

  LOAD_SOURCE_ZIP:
    'load-source-zip',

  RESOLVE_OPTIONS:
    'resolve-converter-options',

  PARSE_PROJECT:
    'parse-source-project',

  BUILD_PROJECT:
    'build-ks1-project',

  REWRITE_METADATA:
    'rewrite-project-metadata',

  COPY_ZIP_ENTRIES:
    'copy-output-zip-entries',

  GENERATE_OUTPUT_ZIP:
    'generate-output-zip',

  CREATE_PROJECT_REPORT:
    'create-project-report',

  FINISHED:
    'conversion-finished',
});

const KS1_DIAGNOSTIC_STAGE_LABELS = Object.freeze({
  [KS1_DIAGNOSTIC_STAGES.CAPTURE_DOWNLOAD]:
    'Capture MakerWorld download',

  [KS1_DIAGNOSTIC_STAGES.FETCH_CAPTURED_RESPONSE]:
    'Read captured MakerWorld response',

  [KS1_DIAGNOSTIC_STAGES.FETCH_CDN_FILE]:
    'Download source 3MF from MakerWorld CDN',

  [KS1_DIAGNOSTIC_STAGES.READ_SETTINGS]:
    'Read extension settings',

  [KS1_DIAGNOSTIC_STAGES.LOAD_PRINTER_PROFILE]:
    'Load selected printer profile',

  [KS1_DIAGNOSTIC_STAGES.START_OUTPUT_DOWNLOAD]:
    'Start converted file download',

  [KS1_DIAGNOSTIC_STAGES.INITIALIZE]:
    'Initialize conversion',

  [KS1_DIAGNOSTIC_STAGES.COPY_INPUT]:
    'Copy source data',

  [KS1_DIAGNOSTIC_STAGES.LOAD_SOURCE_ZIP]:
    'Read source 3MF archive',

  [KS1_DIAGNOSTIC_STAGES.RESOLVE_OPTIONS]:
    'Resolve converter options',

  [KS1_DIAGNOSTIC_STAGES.PARSE_PROJECT]:
    'Parse source project',

  [KS1_DIAGNOSTIC_STAGES.BUILD_PROJECT]:
    'Build KS1 project',

  [KS1_DIAGNOSTIC_STAGES.REWRITE_METADATA]:
    'Rewrite project metadata',

  [KS1_DIAGNOSTIC_STAGES.COPY_ZIP_ENTRIES]:
    'Copy output archive files',

  [KS1_DIAGNOSTIC_STAGES.GENERATE_OUTPUT_ZIP]:
    'Generate converted 3MF archive',

  [KS1_DIAGNOSTIC_STAGES.CREATE_PROJECT_REPORT]:
    'Create conversion report',

  [KS1_DIAGNOSTIC_STAGES.FINISHED]:
    'Conversion finished',
});

function getKS1DiagnosticStageLabel(stageId) {
  return (
    KS1_DIAGNOSTIC_STAGE_LABELS[stageId] ||
    String(stageId || 'Unknown stage')
  );
}

const KS1_STAGE_ERROR_DEFAULTS = Object.freeze({
  [KS1_DIAGNOSTIC_STAGES.CAPTURE_DOWNLOAD]: {
    code:
      KS1_ERROR_CODES.DOWNLOAD_TRIGGER_FAILED,

    userMessage:
      'The MakerWorld download could not be started or captured.',

    userAction:
      'Reload the MakerWorld page, make sure you are signed in, and try again.',

    buttonText:
      'Failed — reload page',
  },

  [KS1_DIAGNOSTIC_STAGES.FETCH_CAPTURED_RESPONSE]: {
    code:
      KS1_ERROR_CODES.DOWNLOAD_INTERCEPT_FAILED,

    userMessage:
      'The captured MakerWorld download response could not be read.',

    userAction:
      'Try the conversion again. Reload the page if the problem persists.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.FETCH_CDN_FILE]: {
    code:
      KS1_ERROR_CODES.DOWNLOAD_HTTP_FAILED,

    userMessage:
      'The source 3MF could not be downloaded from MakerWorld.',

    userAction:
      'Check your connection and try the conversion again.',

    buttonText:
      'Download failed',
  },

  [KS1_DIAGNOSTIC_STAGES.READ_SETTINGS]: {
    code:
      KS1_ERROR_CODES.STORAGE_UNAVAILABLE,

    userMessage:
      'The extension settings could not be read.',

    userAction:
      'Reload the page. If the problem persists, reload the extension.',

    buttonText:
      'Failed — reload page',
  },

  [KS1_DIAGNOSTIC_STAGES.LOAD_PRINTER_PROFILE]: {
    code:
      KS1_ERROR_CODES.PROFILE_LOAD_FAILED,

    userMessage:
      'The selected custom printer profile could not be loaded.',

    userAction:
      'Select the standard KS1 profile or import the custom profile again.',

    buttonText:
      'Profile load failed',
  },

  [KS1_DIAGNOSTIC_STAGES.START_OUTPUT_DOWNLOAD]: {
    code:
      KS1_ERROR_CODES.OUTPUT_DOWNLOAD_FAILED,

    userMessage:
      'The converted file was created, but its download could not be started.',

    userAction:
      'Copy the error report and include it when reporting the download problem.',

    buttonText:
      'Download failed',
  },

  [KS1_DIAGNOSTIC_STAGES.INITIALIZE]: {
    code:
      KS1_ERROR_CODES.UNKNOWN,

    userMessage:
      'The conversion could not be initialized.',

    userAction:
      'Reload the MakerWorld page and try again.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.COPY_INPUT]: {
    code:
      KS1_ERROR_CODES.INPUT_INVALID,

    userMessage:
      'The downloaded 3MF data is empty or invalid.',

    userAction:
      'Try downloading and converting the model again.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.LOAD_SOURCE_ZIP]: {
    code:
      KS1_ERROR_CODES.ZIP_READ_FAILED,

    userMessage:
      'The downloaded 3MF archive could not be opened.',

    userAction:
      'Try the conversion again. If the problem persists, the source file may be invalid.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.RESOLVE_OPTIONS]: {
    code:
      KS1_ERROR_CODES.UNKNOWN,

    userMessage:
      'The converter settings could not be prepared.',

    userAction:
      'Reload the MakerWorld page and try again.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.PARSE_PROJECT]: {
    code:
      KS1_ERROR_CODES.PROJECT_PARSE_FAILED,

    userMessage:
      'The MakerWorld project could not be read.',

    userAction:
      'Try the conversion again. The error report contains the exact parsing stage.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.BUILD_PROJECT]: {
    code:
      KS1_ERROR_CODES.PROJECT_BUILD_FAILED,

    userMessage:
      'The Snapmaker KS1 project could not be created.',

    userAction:
      'Copy the error report and include it when reporting the problem.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.REWRITE_METADATA]: {
    code:
      KS1_ERROR_CODES.METADATA_REWRITE_FAILED,

    userMessage:
      'The converted project metadata could not be written.',

    userAction:
      'Copy the error report and include it when reporting the problem.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.COPY_ZIP_ENTRIES]: {
    code:
      KS1_ERROR_CODES.ZIP_WRITE_FAILED,

    userMessage:
      'The files for the converted 3MF archive could not be assembled.',

    userAction:
      'Copy the error report and include it when reporting the problem.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.GENERATE_OUTPUT_ZIP]: {
    code:
      KS1_ERROR_CODES.ZIP_WRITE_FAILED,

    userMessage:
      'The converted 3MF archive could not be generated.',

    userAction:
      'Try the conversion again. If it fails again, copy the error report.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.CREATE_PROJECT_REPORT]: {
    code:
      KS1_ERROR_CODES.REPORT_FAILED,

    userMessage:
      'The conversion report could not be created.',

    userAction:
      'Disable the conversion report temporarily or reload the page and try again.',

    buttonText:
      'Conversion failed',
  },

  [KS1_DIAGNOSTIC_STAGES.FINISHED]: {
    code:
      KS1_ERROR_CODES.UNKNOWN,

    userMessage:
      'The conversion could not be completed.',

    userAction:
      'Reload the MakerWorld page and try again.',

    buttonText:
      'Conversion failed',
  },
});

function getKS1StageErrorDefaults(stageId) {
  const defaults =
    KS1_STAGE_ERROR_DEFAULTS[stageId];

  if (defaults) {
    return {
      ...defaults,
    };
  }

  return {
    code:
      KS1_ERROR_CODES.UNKNOWN,

    userMessage:
      'The conversion failed because of an unexpected error.',

    userAction:
      'Copy the error report and include it when reporting the problem.',

    buttonText:
      'Conversion failed',
  };
}

function createKS1ConversionId() {
  const timestamp = Date.now().toString(36);

  let randomPart = '';

  try {
    const randomValues = new Uint32Array(2);

    globalThis.crypto?.getRandomValues?.(
      randomValues
    );

    randomPart = Array.from(randomValues)
      .map(value => value.toString(36))
      .join('');
  } catch {
    randomPart = Math.random()
      .toString(36)
      .slice(2, 12);
  }

  if (!randomPart) {
    randomPart = Math.random()
      .toString(36)
      .slice(2, 12);
  }

  return `ks1-${timestamp}-${randomPart}`;
}

function getKS1DiagnosticTime() {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function cloneKS1DiagnosticValue(value) {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      stack: value.stack || '',
    };
  }

  if (Array.isArray(value)) {
    return value.map(cloneKS1DiagnosticValue);
  }

  if (typeof value === 'object') {
    const clone = {};

    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneKS1DiagnosticValue(item);
    }

    return clone;
  }

  return String(value);
}

function sanitizeKS1DiagnosticContext(context = {}) {
  if (
    !context ||
    typeof context !== 'object' ||
    Array.isArray(context)
  ) {
    return {};
  }

  const sanitized = {};

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;

    sanitized[key] = cloneKS1DiagnosticValue(value);
  }

  return sanitized;
}

class KS1ConversionError extends Error {
  constructor({
    code = KS1_ERROR_CODES.UNKNOWN,
    stage = '',
    message = 'Unexpected conversion error.',
    userMessage = 'The conversion failed because of an unexpected error.',
    userAction = '',
    buttonText = 'Conversion failed',
    cause = null,
    context = {},
    simulated = false,
  } = {}) {
    super(String(message || 'Unexpected conversion error.'));

    this.name = 'KS1ConversionError';

    this.code =
      String(code || KS1_ERROR_CODES.UNKNOWN);

    this.stage =
      String(stage || '');

    this.userMessage =
      String(
        userMessage ||
        'The conversion failed because of an unexpected error.'
      );

    this.userAction =
      String(userAction || '');

    this.buttonText =
      String(buttonText || 'Conversion failed');

    this.cause =
      cause || null;

    this.context =
      sanitizeKS1DiagnosticContext(context);

    this.simulated =
      simulated === true;

    if (
      cause?.stack &&
      cause.stack !== this.stack
    ) {
      this.originalStack = String(cause.stack);
    }

    if (
      cause?.name ||
      cause?.message
    ) {
      this.originalError = {
        name:
          String(cause.name || 'Error'),

        message:
          String(cause.message || cause),
      };
    }
  }
}

function isKS1ConversionError(value) {
  return (
    value instanceof KS1ConversionError ||
    (
      value &&
      typeof value === 'object' &&
      value.name === 'KS1ConversionError' &&
      typeof value.code === 'string'
    )
  );
}

function normalizeKS1ConversionError(
  rawError,
  {
    code = KS1_ERROR_CODES.UNKNOWN,
    stage = '',
    message = '',
    userMessage = '',
    userAction = '',
    buttonText = 'Conversion failed',
    context = {},
  } = {}
) {
  if (isKS1ConversionError(rawError)) {
    if (!rawError.stage && stage) {
      rawError.stage = String(stage);
    }

    rawError.context = {
      ...sanitizeKS1DiagnosticContext(context),
      ...sanitizeKS1DiagnosticContext(
        rawError.context
      ),
    };

    return rawError;
  }

  const technicalMessage =
    message ||
    (
      rawError instanceof Error
        ? rawError.message
        : String(
            rawError ||
            'Unexpected conversion error.'
          )
    );

  return new KS1ConversionError({
    code,
    stage,

    message:
      technicalMessage,

    userMessage:
      userMessage ||
      'The conversion failed because of an unexpected error.',

    userAction,
    buttonText,

    cause:
      rawError instanceof Error
        ? rawError
        : null,

    context: {
      ...sanitizeKS1DiagnosticContext(
        rawError?.ks1DiagnosticContext
      ),

      ...sanitizeKS1DiagnosticContext(
        context
      ),

      simulatedFault:
        rawError?.ks1SimulatedFault,
    },

    simulated:
      rawError?.ks1Simulated === true,
  });
}

class KS1ConversionDiagnostics {
  constructor(initialMetadata = {}) {
    this.id =
      createKS1ConversionId();

    this.startedAt =
      new Date().toISOString();

    this.startedAtPerformance =
      getKS1DiagnosticTime();

    this.finishedAt =
      null;

    this.durationMs =
      null;

    this.currentStage =
      '';

    this.currentOperation =
      {};

    this.metadata =
      sanitizeKS1DiagnosticContext(
        initialMetadata
      );

    this.stages = [];
    this.error = null;
  }

  setMetadata(values = {}) {
    this.metadata = {
      ...this.metadata,
      ...sanitizeKS1DiagnosticContext(values),
    };

    return this;
  }

  setOperation(values = {}) {
    this.currentOperation =
      sanitizeKS1DiagnosticContext(values);

    return this;
  }

  clearOperation() {
    this.currentOperation = {};
    return this;
  }

  startStage(id, label = '', context = {}) {
    const stageId =
      String(id || '').trim();

    if (!stageId) {
      throw new TypeError(
        'Diagnostic stage requires an id.'
      );
    }

    const existingRunningStage =
      this.stages.find(
        stage =>
          stage.status ===
          KS1_DIAGNOSTIC_STAGE_STATUS.RUNNING
      );

    if (existingRunningStage) {
      this.completeStage(
        existingRunningStage.id
      );
    }

    const stage = {
      id: stageId,

      label:
        String(label || stageId),

      status:
        KS1_DIAGNOSTIC_STAGE_STATUS.RUNNING,

      startedAt:
        getKS1DiagnosticTime(),

      durationMs:
        null,

      context:
        sanitizeKS1DiagnosticContext(context),
    };

    this.currentStage =
      stageId;

    this.currentOperation = {};

    this.stages.push(stage);

    return stage;
  }

  findLatestStage(id = '') {
    const stageId =
      String(id || this.currentStage || '');

    for (
      let index = this.stages.length - 1;
      index >= 0;
      index--
    ) {
      if (
        this.stages[index].id === stageId
      ) {
        return this.stages[index];
      }
    }

    return null;
  }

  completeStage(id = '') {
    const stage =
      this.findLatestStage(id);

    if (!stage) return null;

    if (
      stage.status ===
      KS1_DIAGNOSTIC_STAGE_STATUS.RUNNING
    ) {
      stage.status =
        KS1_DIAGNOSTIC_STAGE_STATUS.OK;

      stage.durationMs =
        Math.max(
          0,
          getKS1DiagnosticTime() -
          stage.startedAt
        );
    }

    this.currentOperation = {};

    return stage;
  }

  failStage(
    rawError,
    {
      code = KS1_ERROR_CODES.UNKNOWN,
      stage = '',
      message = '',
      userMessage = '',
      userAction = '',
      buttonText = 'Conversion failed',
      context = {},
    } = {}
  ) {
    const failedStageId =
      String(
        stage ||
        this.currentStage ||
        'unknown'
      );

    let stageRecord =
      this.findLatestStage(
        failedStageId
      );

    if (!stageRecord) {
      stageRecord =
        this.startStage(
          failedStageId,
          failedStageId
        );
    }

    stageRecord.status =
      KS1_DIAGNOSTIC_STAGE_STATUS.FAILED;

    stageRecord.durationMs =
      Math.max(
        0,
        getKS1DiagnosticTime() -
        stageRecord.startedAt
      );

    const error =
      normalizeKS1ConversionError(
        rawError,
        {
          code,
          stage:
            failedStageId,

          message,
          userMessage,
          userAction,
          buttonText,

          context: {
            ...stageRecord.context,
            ...this.currentOperation,
            ...sanitizeKS1DiagnosticContext(
              context
            ),
          },
        }
      );

    this.error = error;
    this.currentStage = failedStageId;

    this.finish();

    return error;
  }

  finish() {
    if (!this.finishedAt) {
      this.finishedAt =
        new Date().toISOString();

      this.durationMs =
        Math.max(
          0,
          getKS1DiagnosticTime() -
          this.startedAtPerformance
        );
    }

    return this;
  }

  snapshot() {
    return {
      id:
        this.id,

      startedAt:
        this.startedAt,

      finishedAt:
        this.finishedAt,

      durationMs:
        this.durationMs,

      currentStage:
        this.currentStage,

      currentOperation:
        sanitizeKS1DiagnosticContext(
          this.currentOperation
        ),

      metadata:
        sanitizeKS1DiagnosticContext(
          this.metadata
        ),

      stages:
        this.stages.map(stage => ({
          id:
            stage.id,

          label:
            stage.label,

          status:
            stage.status,

          durationMs:
            stage.durationMs,

          context:
            sanitizeKS1DiagnosticContext(
              stage.context
            ),
        })),

      error:
        this.error
          ? {
              name:
                this.error.name,

              code:
                this.error.code,

              stage:
                this.error.stage,

              message:
                this.error.message,

              userMessage:
                this.error.userMessage,

              userAction:
                this.error.userAction,

              buttonText:
                this.error.buttonText,

              context:
                sanitizeKS1DiagnosticContext(
                  this.error.context
                ),

              simulated:
                this.error.simulated === true,

              originalError:
                cloneKS1DiagnosticValue(
                  this.error.originalError
                ),

              stack:
                this.error.stack || '',

              originalStack:
                this.error.originalStack || '',
            }
          : null,
    };
  }
}

function createKS1ConversionDiagnostics(
  initialMetadata = {}
) {
  return new KS1ConversionDiagnostics(
    initialMetadata
  );
}

// -----------------------------------------------------------------------------
// Developer fault simulation
// -----------------------------------------------------------------------------

function throwKS1SimulatedFault(
  activeFault,
  expectedFault,
  message = 'Simulated conversion failure.',
  context = {}
) {
  const selectedFault =
    String(activeFault || 'none');

  const targetFault =
    String(expectedFault || '');

  if (
    selectedFault === 'none' ||
    !targetFault ||
    selectedFault !== targetFault
  ) {
    return;
  }

  const error =
    new Error(
      String(
        message ||
        'Simulated conversion failure.'
      )
    );

  error.name =
    'KS1SimulatedFaultError';

  error.ks1Simulated =
    true;

  error.ks1SimulatedFault =
    targetFault;

  error.ks1DiagnosticContext =
    sanitizeKS1DiagnosticContext(
      context
    );

  throw error;
}

// -----------------------------------------------------------------------------
// Conversion error preparation
// -----------------------------------------------------------------------------

function getKS1ErrorDiagnostics(
  error,
  fallbackDiagnostics = null
) {
  if (
    error?.diagnostics &&
    typeof error.diagnostics === 'object'
  ) {
    return cloneKS1DiagnosticValue(
      error.diagnostics
    );
  }

  if (
    fallbackDiagnostics instanceof
    KS1ConversionDiagnostics
  ) {
    return fallbackDiagnostics.snapshot();
  }

  if (
    fallbackDiagnostics &&
    typeof fallbackDiagnostics === 'object'
  ) {
    return cloneKS1DiagnosticValue(
      fallbackDiagnostics
    );
  }

  return null;
}

function prepareKS1ErrorForReport(
  rawError,
  {
    diagnostics = null,
    code = KS1_ERROR_CODES.UNKNOWN,
    stage = '',
    userMessage = '',
    userAction = '',
    buttonText = 'Conversion failed',
    context = {},
  } = {}
) {
  const activeStage =
    stage ||
    diagnostics?.currentStage ||
    rawError?.stage ||
    'unknown';

  let error;

  if (
    diagnostics instanceof
    KS1ConversionDiagnostics &&
    !diagnostics.error
  ) {
    error = diagnostics.failStage(
      rawError,
      {
        code,
        stage:
          activeStage,

        userMessage:
          userMessage ||
          'The conversion failed because of an unexpected error.',

        userAction:
          userAction ||
          'Copy the error report and include it when reporting the problem.',

        buttonText,

        context,
      }
    );
  } else {
    error = normalizeKS1ConversionError(
      rawError,
      {
        code,
        stage:
          activeStage,

        userMessage:
          userMessage ||
          'The conversion failed because of an unexpected error.',

        userAction:
          userAction ||
          'Copy the error report and include it when reporting the problem.',

        buttonText,

        context,
      }
    );
  }

  const reportDiagnostics =
    getKS1ErrorDiagnostics(
      error,
      diagnostics
    );

  if (reportDiagnostics) {
    error.diagnostics =
      reportDiagnostics;
  }

  return error;
}

function getConverterVersion() {
  try {
    return chrome.runtime.getManifest().version || 'unknown';
  } catch (error) {
    console.warn(
      '[KS1 Converter] Could not read extension version from manifest:',
      error
    );
    return 'unknown';
  }
}

function parseXml(str) {
  return new DOMParser().parseFromString(str, 'application/xml');
}

function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

function padArray(arr, length, fillValue) {
  const out = arr.slice(0, length);
  while (out.length < length) out.push(fillValue ?? arr[arr.length - 1]);
  return out;
}

// Copy binary input into this script's own JavaScript realm.
//
// Firefox content scripts can expose fetched TypedArrays through an isolated
// cross-compartment wrapper. JSZip then fails while detecting the input type.
// A byte-by-byte copy avoids constructor, iterator and TypedArray species access
// on the wrapped source object.
function copyBinaryInputToLocalUint8Array(input) {
  const length = Number(input?.byteLength);

  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new TypeError('Invalid or empty 3MF input');
  }

  const localBytes = new Uint8Array(length);

  for (let i = 0; i < length; i++) {
    localBytes[i] = input[i];
  }

  return localBytes;
}

async function convertToKS1(inputBuffer, opts = {}) {
  const conversionStartedAt = performance.now();
  const performanceTimings = {};

  const ownsDiagnostics =
    !(
      opts?.ks1Diagnostics instanceof
      KS1ConversionDiagnostics
    );

  const diagnostics =
    ownsDiagnostics
      ? createKS1ConversionDiagnostics()
      : opts.ks1Diagnostics;

  try {
    diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.INITIALIZE,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.INITIALIZE
    )
  );

  diagnostics.setMetadata({
    converterVersion:
      getConverterVersion(),

    inputBytes:
      Number.isFinite(Number(inputBuffer?.byteLength))
        ? Number(inputBuffer.byteLength)
        : null,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.INITIALIZE
  );

  // ---------------------------------------------------------------------------
  // Copy source input into the content script realm
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.COPY_INPUT,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.COPY_INPUT
    ),
    {
      inputBytes:
        Number.isFinite(Number(inputBuffer?.byteLength))
          ? Number(inputBuffer.byteLength)
          : null,
    }
  );

  let stageStartedAt = performance.now();

  const localInput =
    copyBinaryInputToLocalUint8Array(
      inputBuffer
    );

  performanceTimings.inputCopyMs =
    performance.now() - stageStartedAt;

  diagnostics.setMetadata({
    localInputBytes:
      localInput.byteLength,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.COPY_INPUT
  );

  // ---------------------------------------------------------------------------
  // Read source 3MF ZIP
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.LOAD_SOURCE_ZIP,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.LOAD_SOURCE_ZIP
    ),
    {
      inputBytes:
        localInput.byteLength,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    opts?.ks1TestFault,
    'invalid-zip',
    'Simulated invalid source ZIP.'
  );

  const zip =
    await JSZip.loadAsync(localInput);

  performanceTimings.zipLoadMs =
    performance.now() - stageStartedAt;

  diagnostics.setMetadata({
    sourceZipEntries:
      Object.keys(zip.files).length,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.LOAD_SOURCE_ZIP
  );

  // ---------------------------------------------------------------------------
  // Resolve current converter options
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.RESOLVE_OPTIONS,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.RESOLVE_OPTIONS
    )
  );

  const resolvedOptions = {
    printProfileMode:
      'preserve',

    forcedProfileId:
      '0.20mm-standard',

    filamentPresetMode:
      'preserve',

    forceExcludeObject:
      true,

    forceBrimOff:
      true,

    autoFixOrganicVariableLayer:
      true,

    fixMultiPlatePositioning:
      true,

    debugReport:
      true,

    deepDebugReport:
      false,

    smartProcessMerge:
      true,

    strictProcessMerge:
      false,

    orcaCompatibility:
      false,

    ...(opts || {}),
    ...(opts.converterOptions || {}),

    // Internal diagnostics reference.
    //
    // Object-valued options are already excluded from the normal
    // converter-options console table.
    ks1Diagnostics:
      diagnostics,
  };

  diagnostics.setMetadata({
    targetSlicer:
      resolvedOptions.orcaCompatibility === true
        ? 'OrcaSlicer'
        : 'Snapmaker Orca',

    converterOptions: {
      printProfileMode:
        resolvedOptions.printProfileMode,

      forcedProfileId:
        resolvedOptions.forcedProfileId,

      selectedCustomPrinterProfileId:
        resolvedOptions.selectedCustomPrinterProfileId ||
        KS1_CUSTOM_PRINTER_STANDARD_ID,

      orcaCompatibility:
        resolvedOptions.orcaCompatibility === true,

      filamentPresetMode:
        resolvedOptions.filamentPresetMode,

      forceExcludeObject:
        resolvedOptions.forceExcludeObject !== false,

      forceBrimOff:
        resolvedOptions.forceBrimOff !== false,

      autoFixOrganicVariableLayer:
        resolvedOptions.autoFixOrganicVariableLayer !== false,

      fixMultiPlatePositioning:
        resolvedOptions.fixMultiPlatePositioning !== false,

      smartProcessMerge:
        resolvedOptions.smartProcessMerge !== false,

      strictProcessMerge:
        resolvedOptions.strictProcessMerge === true,

      debugReport:
        resolvedOptions.debugReport !== false,

      deepDebugReport:
        resolvedOptions.deepDebugReport === true,
    },
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.RESOLVE_OPTIONS
  );

  // ---------------------------------------------------------------------------
  // Parse original 3MF into project object
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.PARSE_PROJECT,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.PARSE_PROJECT
    ),
    {
      zipEntries:
        Object.keys(zip.files).length,

      deepDebugReport:
        resolvedOptions.deepDebugReport === true,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'project-parse-failure',
    'Simulated project parsing failure.'
  );

  const sourceProject =
    await parseProject(
      zip,
      resolvedOptions
    );

  performanceTimings.projectParseMs =
    performance.now() - stageStartedAt;

  sourceProject.options = {
    ...(sourceProject.options || {}),
    ...resolvedOptions,
  };

  diagnostics.setMetadata({
    sourceFileCount:
      sourceProject.stats?.fileCount ?? null,

    sourceObjectCount:
      sourceProject.analysis?.model?.objectCount ??
      null,

    sourceBuildItemCount:
      sourceProject.analysis?.model?.buildItemCount ??
      null,

    sourceFilamentCount:
      sourceProject.filaments?.source?.length ??
      null,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.PARSE_PROJECT
  );

  // ---------------------------------------------------------------------------
  // Build converted KS1 project settings
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.BUILD_PROJECT,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.BUILD_PROJECT
    ),
    {
      sourceFilamentCount:
        sourceProject.filaments?.source?.length ??
        null,

      printProfileMode:
        resolvedOptions.printProfileMode,

      orcaCompatibility:
        resolvedOptions.orcaCompatibility === true,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'project-build-failure',
    'Simulated KS1 project build failure.'
  );

  const project =
    await buildKS1Project(
      sourceProject,
      {
        ...(opts || {}),
        converterOptions:
          resolvedOptions,

        ks1Diagnostics:
          diagnostics,
      }
    );

  performanceTimings.projectBuildMs =
    performance.now() - stageStartedAt;

  diagnostics.setMetadata({
    finalFilamentCount:
      project.filaments?.mapped?.ids?.length ??
      null,

    finalPrinterProfile:
      project.ks1?.settings?.printer_settings_id ||
      null,

    finalPrintProfile:
      project.ks1?.settings?.print_settings_id ||
      null,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.BUILD_PROJECT
  );

  // ---------------------------------------------------------------------------
  // Rewrite 3MF metadata and model files
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.REWRITE_METADATA,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.REWRITE_METADATA
    ),
    {
      multiPlateFixEnabled:
        resolvedOptions.fixMultiPlatePositioning !== false,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'metadata-rewrite-failure',
    'Simulated project metadata rewrite failure.'
  );

  const metadata =
    await rewriteKS13mfMetadata(
      zip,
      project
    );
  performanceTimings.metadataRewriteMs =
    performance.now() - stageStartedAt;

  project.metadata = {
    ...(project.metadata || {}),
    rewritten:
      metadata,
  };

  diagnostics.setMetadata({
    sliceInfoRewritten:
      typeof metadata.modifiedSliceInfo ===
      'string',

    modelSettingsRewritten:
      typeof metadata.modifiedModelSettings ===
      'string',

    mainModelRewritten:
      typeof metadata.modified3DModel ===
      'string',

    multiPlatePositioningApplied:
      metadata.multiPlatePositioning?.applied ===
      true,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.REWRITE_METADATA
  );

  // ---------------------------------------------------------------------------
  // Build output ZIP structure
  // ---------------------------------------------------------------------------

  const outZip =
    new JSZip();

  let copiedFileCount =
    0;

  let rewrittenFileCount =
    0;

  let directoryCount =
    0;

  let skippedUnsafeFileCount =
    0;

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.COPY_ZIP_ENTRIES,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.COPY_ZIP_ENTRIES
    ),
    {
      sourceZipEntries:
        Object.keys(zip.files).length,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'zip-copy-failure',
    'Simulated output ZIP entry copy failure.'
  );

  for (const name of Object.keys(zip.files)) {
    diagnostics.setOperation({
      operation:
        'copy-zip-entry',

      path:
        name,
    });

    const entry =
      zip.file(name);

    if (!entry || entry.dir) {
      if (entry?.dir) {
        outZip.folder(name);
        directoryCount++;
      }

      continue;
    }

    const safe =
      name
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    if (
      safe.startsWith('..') ||
      safe.includes('/../')
    ) {
      skippedUnsafeFileCount++;
      continue;
    }

    if (
      name ===
      'Metadata/project_settings.config'
    ) {
      outZip.file(
        name,
        project.ks1.settingsBytes
      );

      rewrittenFileCount++;
    } else if (
      name ===
        'Metadata/slice_info.config' &&
      metadata.modifiedSliceInfo
    ) {
      outZip.file(
        name,
        metadata.modifiedSliceInfo
      );

      rewrittenFileCount++;
    } else if (
      name ===
        'Metadata/model_settings.config' &&
      metadata.modifiedModelSettings
    ) {
      outZip.file(
        name,
        metadata.modifiedModelSettings
      );

      rewrittenFileCount++;
    } else if (
      name ===
        '3D/3dmodel.model' &&
      metadata.modified3DModel
    ) {
      outZip.file(
        name,
        metadata.modified3DModel
      );

      rewrittenFileCount++;
    } else {
      outZip.file(
        name,
        await entry.async('uint8array')
      );

      copiedFileCount++;
    }
  }

  diagnostics.clearOperation();

  performanceTimings.zipEntryCopyMs =
    performance.now() - stageStartedAt;

  diagnostics.setMetadata({
    copiedFileCount,
    rewrittenFileCount,
    directoryCount,
    skippedUnsafeFileCount,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.COPY_ZIP_ENTRIES
  );

  // ---------------------------------------------------------------------------
  // Generate final compressed output
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.GENERATE_OUTPUT_ZIP,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.GENERATE_OUTPUT_ZIP
    ),
    {
      compression:
        'DEFLATE',

      compressionLevel:
        4,

      copiedFileCount,
      rewrittenFileCount,
    }
  );

  stageStartedAt = performance.now();

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'zip-build-failure',
    'Simulated output ZIP generation failure.'
  );

  const outputBytes =
    await outZip.generateAsync({
      type:
        'uint8array',

      compression:
        'DEFLATE',

      compressionOptions: {
        level:
          4,
      },
    });

  performanceTimings.zipGenerateMs =
    performance.now() - stageStartedAt;

  diagnostics.setMetadata({
    outputBytes:
      outputBytes.byteLength,
  });

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.GENERATE_OUTPUT_ZIP
  );

  performanceTimings.totalMs =
    performance.now() - conversionStartedAt;

  project.converter = {
    version:
      getConverterVersion(),

    conversionMs:
      Math.round(
        performanceTimings.totalMs
      ),

    performance: {
      timings:
        Object.fromEntries(
          Object.entries(
            performanceTimings
          ).map(([key, value]) => [
            key,
            Math.round(value * 100) / 100,
          ])
        ),

      inputBytes:
        localInput.byteLength,

      outputBytes:
        outputBytes.byteLength,

      zipEntryCount:
        Object.keys(zip.files).length,

      copiedFileCount,
      rewrittenFileCount,
      directoryCount,
      skippedUnsafeFileCount,

      compression:
        'DEFLATE',
    },

    diagnostics:
      null,
  };

  // ---------------------------------------------------------------------------
  // Create existing conversion report
  // ---------------------------------------------------------------------------

  diagnostics.startStage(
    KS1_DIAGNOSTIC_STAGES.CREATE_PROJECT_REPORT,
    getKS1DiagnosticStageLabel(
      KS1_DIAGNOSTIC_STAGES.CREATE_PROJECT_REPORT
    ),
    {
      enabled:
        project.options?.debugReport !== false,
    }
  );

  throwKS1SimulatedFault(
    resolvedOptions.ks1TestFault,
    'project-report-failure',
    'Simulated conversion report failure.'
  );

  if (
    project.options?.debugReport !== false
  ) {
    logKS1ProjectReport(project);
  }

  diagnostics.completeStage(
    KS1_DIAGNOSTIC_STAGES.CREATE_PROJECT_REPORT
  );

  // ---------------------------------------------------------------------------
  // Finish diagnostics
  // ---------------------------------------------------------------------------

  // When convertToKS1() created the tracker itself, this function represents
  // the complete workflow and therefore finishes it here.
  //
  // When content.js supplied the tracker, the outer workflow still has to
  // start the browser download. In that case content.js finishes it later.
  if (ownsDiagnostics) {
    diagnostics.startStage(
      KS1_DIAGNOSTIC_STAGES.FINISHED,
      getKS1DiagnosticStageLabel(
        KS1_DIAGNOSTIC_STAGES.FINISHED
      )
    );

    diagnostics.completeStage(
      KS1_DIAGNOSTIC_STAGES.FINISHED
    );

    diagnostics.finish();
  }

  project.converter.diagnostics =
    diagnostics.snapshot();

  return outputBytes;
  } catch (rawError) {
    const failedStage =
      diagnostics.currentStage ||
      KS1_DIAGNOSTIC_STAGES.INITIALIZE;

    const stageDefaults =
      getKS1StageErrorDefaults(
        failedStage
      );

    const normalizedError =
      diagnostics.failStage(
        rawError,
        {
          ...stageDefaults,

          stage:
            failedStage,

          context: {
            converterVersion:
              getConverterVersion(),

            stageLabel:
              getKS1DiagnosticStageLabel(
                failedStage
              ),
          },
        }
      );

    // Attach the complete immutable report state directly to the error.
    //
    // content.js can later use this object for:
    // - console summary
    // - full error report
    // - tooltip
    // - Copy error report
    normalizedError.diagnostics =
      diagnostics.snapshot();

    throw normalizedError;
  }
}
