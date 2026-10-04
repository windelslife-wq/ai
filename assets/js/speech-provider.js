/**
 * WINDELS AI WORKFORCE — SpeechProvider abstraction
 * Provides real text-to-speech and speech-to-text using browser APIs where available.
 * Allows future provider swapping (e.g. cloud TTS) via same interface.
 *
 * Usage:
 *   const provider = new SpeechProvider();
 *   provider.healthCheck() -> { tts: boolean, stt: boolean, voices: number }
 *   provider.getSupportedVoices() -> SpeechSynthesisVoice[]
 *   provider.textToSpeech(text, { locale, voice, rate, onEnd, onError })
 *   provider.speechToText({ locale, onResult, onError, onEnd })
 */

class SpeechProvider {
  constructor() {
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null;
    this._voices = [];
    this._voicesReady = false;
    if (this.synth) {
      this._voices = this.synth.getVoices();
      if (this._voices.length === 0) {
        // Voices load async in some browsers
        this.synth.onvoiceschanged = () => {
          this._voices = this.synth.getVoices();
          this._voicesReady = true;
        };
      } else {
        this._voicesReady = true;
      }
    }
  }

  healthCheck() {
    return {
      tts: !!this.synth,
      stt: !!this.SR,
      voices: this._voices.length,
      voicesReady: this._voicesReady,
      ttsNote: this.synth ? null : 'Text-to-speech not available in this browser.',
      sttNote: this.SR ? null : 'Speech recognition not available in this browser.',
    };
  }

  getSupportedVoices() {
    if (this.synth) {
      this._voices = this.synth.getVoices();
    }
    return this._voices.slice();
  }

  getVoicesForLocale(locale) {
    const voices = this.getSupportedVoices();
    if (!locale) return voices;
    const lower = locale.toLowerCase();
    const base = lower.split('-')[0];
    const matches = voices.filter(v => {
      const vl = (v.lang || '').toLowerCase();
      return vl === lower || vl.startsWith(base + '-') || vl === base || vl.startsWith(base);
    });
    // Prefer exact match, then base
    matches.sort((a, b) => {
      const al = (a.lang || '').toLowerCase();
      const bl = (b.lang || '').toLowerCase();
      if (al === lower && bl !== lower) return -1;
      if (bl === lower && al !== lower) return 1;
      return 0;
    });
    return matches.length ? matches : voices.filter(v => (v.lang || '').toLowerCase().startsWith(base));
  }

  /**
   * Speak text with correct locale
   * @param {string} text
   * @param {object} opts { locale, voice (SpeechSynthesisVoice or index), rate (0.5-1.5), volume, onStart, onEnd, onError }
   * @returns {SpeechSynthesisUtterance|null}
   */
  textToSpeech(text, opts = {}) {
    if (!this.synth || !text) {
      if (opts.onError) opts.onError(new Error('TTS not available'));
      return null;
    }
    this.synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = opts.locale || 'en-US';
    utter.rate = typeof opts.rate === 'number' ? opts.rate : 1;
    utter.volume = typeof opts.volume === 'number' ? opts.volume : 1;
    utter.pitch = typeof opts.pitch === 'number' ? opts.pitch : 1;

    if (opts.voice) {
      if (typeof opts.voice === 'object' && opts.voice.lang) {
        utter.voice = opts.voice;
        utter.lang = opts.voice.lang;
      } else if (typeof opts.voice === 'number') {
        const voices = this.getVoicesForLocale(utter.lang);
        if (voices[opts.voice]) {
          utter.voice = voices[opts.voice];
          utter.lang = voices[opts.voice].lang;
        }
      }
    } else {
      const matches = this.getVoicesForLocale(utter.lang);
      if (matches.length) {
        utter.voice = matches[0];
        utter.lang = matches[0].lang;
      }
    }

    if (opts.onStart) utter.onstart = opts.onStart;
    if (opts.onEnd) utter.onend = opts.onEnd;
    if (opts.onError) utter.onerror = (e) => opts.onError(e);
    else utter.onerror = () => {};

    this.synth.speak(utter);
    return utter;
  }

  stop() {
    if (this.synth) this.synth.cancel();
  }

  /**
   * Speech to text
   * @param {object} opts { locale, interimResults, maxAlternatives, onResult (transcript), onError, onEnd, onStart }
   * @returns {SpeechRecognition|null}
   */
  speechToText(opts = {}) {
    if (!this.SR) {
      if (opts.onError) opts.onError(new Error('STT not available'));
      return null;
    }
    const rec = new this.SR();
    rec.lang = opts.locale || 'en-US';
    rec.interimResults = !!opts.interimResults;
    rec.maxAlternatives = opts.maxAlternatives || 1;
    rec.continuous = !!opts.continuous;

    if (opts.onResult) {
      rec.onresult = (ev) => {
        const transcript = ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '';
        opts.onResult(transcript, ev);
      };
    }
    if (opts.onError) rec.onerror = (ev) => opts.onError(ev);
    if (opts.onEnd) rec.onend = opts.onEnd;
    if (opts.onStart) rec.onstart = opts.onStart;

    try {
      rec.start();
    } catch (e) {
      if (opts.onError) opts.onError(e);
      return null;
    }
    return rec;
  }
}

// Expose globally for inline scripts
if (typeof window !== 'undefined') {
  window.SpeechProvider = SpeechProvider;
  window.windelsSpeech = new SpeechProvider();
}
