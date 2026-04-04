const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

class Summarizer {
  constructor(settings) {
    this.updateSettings(settings || {});
  }

  updateSettings(settings) {
    this.settings = settings;
    // Reinitialize SDKs
    if (this.settings.geminiApiKey) {
      this.ai = new GoogleGenAI({ apiKey: this.settings.geminiApiKey });
    } else {
      this.ai = null;
    }

    if (this.settings.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: this.settings.openaiApiKey });
    } else {
      this.openai = null;
    }
  }

  async callGemini(prompt) {
    if (!this.ai) throw new Error("Gemini API key not configured.");
    const response = await this.ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: prompt
    });
    return response.text;
  }

  async callOpenAI(prompt) {
    if (!this.openai) throw new Error("OpenAI API key not configured.");
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    return response.choices[0].message.content;
  }

  async generateSummary(transcriptsText) {
    if (!transcriptsText || transcriptsText.trim() === '') {
      throw new Error("No transcript data available to summarize.");
    }

    const prompt = `Act as an executive assistant. You have been handed the raw transcript of a meeting (originally in Tamil, translated to English). Your job is to output a "Granola-style" structured summary.

Requirements:
- Output MUST be entirely in English.
- Use a clear professional tone.
- The very first line MUST be exactly: "Title: [A short, descriptive 3-5 word title for the meeting]"
- Section 1: TL;DR (1-2 sentences summarizing the main point).
- Section 2: Key Decisions (bullet points).
- Section 3: Action Items (bullet points, who is doing what).

Transcript:
${transcriptsText}
`;

    const useOpenAI = this.settings.defaultSummarizer === 'openai';

    try {
      if (useOpenAI) {
         return await this.callOpenAI(prompt);
      } else {
         return await this.callGemini(prompt);
      }
    } catch (e) {
      console.warn(`Primary model (${useOpenAI ? 'OpenAI' : 'Gemini'}) failed. Trying fallback...`, e.message);
      try {
         if (useOpenAI) {
            return await this.callGemini(prompt);
         } else {
            return await this.callOpenAI(prompt);
         }
      } catch (fallbackError) {
         console.error("Fallback summarization also failed:", fallbackError);
         throw new Error(`Summarization failed: Primary(${e.message}) | Fallback(${fallbackError.message})`);
      }
    }
  }
}

module.exports = { Summarizer };
