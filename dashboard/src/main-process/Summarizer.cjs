const { GoogleGenAI } = require('@google/genai');

class Summarizer {
  constructor(apiKey) {
    if (!apiKey) {
      console.warn("No GEMINI_API_KEY provided. Summarization will fail.");
    }
    this.ai = new GoogleGenAI({ apiKey });
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

    try {
      // Use gemini-3.0-flash as requested
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.0-flash',
        contents: prompt
      });
      return response.text;
    } catch (e) {
      console.error("Gemini summary error:", e);
      throw e;
    }
  }
}

module.exports = { Summarizer };
