/* global freezr, MediaRecorder, navigator */

// Hold-to-talk dictation for the chat input.
//
// The transcript lands in the textarea for the user to EDIT — it is never auto-sent. A
// misheard word in a chat app is a typo; a misheard word here is a build instruction that
// rewrites their files, so the user reads it before it goes anywhere.
//
// Nothing is stored. The clip lives in memory for the length of one request and is dropped;
// it never reaches the user's db, and the mic track is stopped the moment recording ends
// rather than at page unload (a browser tab holding an open mic is its own problem).

let mediaRecorder = null
let chunks = []
let stream = null

/** Is voice usable at all? Cached on the module, since it only changes with the user's keys. */
let voiceSupport = null

/**
 * `anyProvider` matters here: voice is ChatGPT-only, so a user whose DEFAULT provider is
 * Claude but who also holds a ChatGPT key can still dictate — the server picks the capable
 * key for voice calls. Asking about the default alone would hide the mic from someone it
 * would have worked for.
 *
 * It also reports WHICH provider will be spent, because that is genuinely surprising when it
 * is not the one you chose: picking Claude in the model settings and then seeing a mic that
 * quietly bills your ChatGPT key deserves to be said out loud in the tooltip rather than
 * discovered on the bill.
 *
 * @returns {Promise<{ supported: boolean, provider: string|null }>}
 */
export const checkVoiceSupport = async () => {
  if (voiceSupport !== null) return voiceSupport

  // No mic, or an insecure context (plain http on a non-localhost host) — the API is simply
  // absent there, and a button that cannot work is worse than no button. Checked first so a
  // browser that could never record does not cost a ping.
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    voiceSupport = { supported: false, provider: null }
    return voiceSupport
  }

  try {
    // 'unknown' means "try it": show the button and let a real failure speak for itself,
    // rather than hiding a feature the provider simply has not documented.
    const answer = await freezr.llm.can('voice.stt', { anyProvider: true })
    let provider = null
    if (answer !== false) {
      // capabilities() shares can()'s memoized ping, so this costs no extra request — and a
      // ping is not cheap: it lists every text, image and voice model and reads the pricing
      // table for each.
      const { capabilities, defaultProvider } = await freezr.llm.capabilities()
      const capable = Object.keys(capabilities).filter(name => capabilities[name]?.voice)
      // Prefer the user's own default when it can do this, so the tooltip only names a
      // different provider when one is genuinely being substituted.
      provider = capable.includes(defaultProvider) ? defaultProvider : (capable[0] || null)
    }
    voiceSupport = { supported: answer !== false, provider }
  } catch (e) {
    voiceSupport = { supported: false, provider: null }
  }
  return voiceSupport
}

export const isRecording = () => Boolean(mediaRecorder && mediaRecorder.state === 'recording')

const releaseMic = () => {
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  mediaRecorder = null
}

/**
 * Start recording. Resolves once the mic is live (the browser may prompt for permission
 * first), so the caller can show the recording state only once it is actually true.
 */
export const startDictation = async () => {
  if (isRecording()) return
  stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  chunks = []
  mediaRecorder = new MediaRecorder(stream)
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data) }
  mediaRecorder.start()
}

/**
 * Stop recording and transcribe. Returns the text, or '' when there was nothing to hear.
 * Always releases the mic, including on failure.
 */
export const stopDictationAndTranscribe = async () => {
  if (!mediaRecorder) return ''
  const recorder = mediaRecorder
  const mimeType = recorder.mimeType || 'audio/webm'

  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    if (recorder.state === 'recording') recorder.stop()
    else resolve(new Blob(chunks, { type: mimeType }))
  })
  releaseMic()
  chunks = []

  // A tap rather than a hold: too short to contain speech, and transcribing it would bill for
  // nothing. The threshold is deliberately generous — a real word is comfortably bigger.
  if (!blob || blob.size < 1200) return ''

  // The filename EXTENSION is what tells the API the container format, so it has to match the
  // recorder's actual mimeType — a .webm name on an .mp4 clip is rejected as unsupported.
  const ext = mimeType.includes('mp4') ? 'mp4' : (mimeType.includes('ogg') ? 'ogg' : 'webm')
  const file = new File([blob], 'dictation.' + ext, { type: mimeType.split(';')[0] })

  const result = await freezr.llm.transcribe(file, { language: navigator.language?.slice(0, 2) || undefined })
  return (result?.text || '').trim()
}

/** Abandon a recording without transcribing it — used when the user cancels or navigates. */
export const cancelDictation = () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.onstop = null
    try { mediaRecorder.stop() } catch (e) { /* already stopped */ }
  }
  releaseMic()
  chunks = []
}
