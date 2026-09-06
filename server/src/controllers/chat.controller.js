const axios = require('axios');
const crypto = require('crypto');

const sessions = new Map();

const systemPrompt = `You are the Happy Hair Expert, a friendly, professional AI assistant for 'Happy Hair by MG Living'. 
Happy Hair is a premium 250g Instant Seeds Powder Mix designed to support healthy hair growth, reduce hair fall, and restore natural shine. 
Price: ₹699. 
Ingredients: Pumpkin seeds, flax seeds, chia seeds, sunflower seeds, cashew, dry fruits, white sesame, almonds, and walnuts. 100% Natural, FSSAI Certified, No Preservatives.
Directions for use: Take 1-2 scoops daily with milk, water, or add to your smoothie/cereal.
Shipping: Free shipping on prepaid orders.
Tone: Warm, empathetic, and knowledgeable. Keep responses concise (1-3 short paragraphs). Use emojis occasionally. 
If asked about medical conditions, clarify you are an AI assistant and recommend consulting a doctor.`;

const handleChat = async (req, res) => {
  try {
    const { message, session_id } = req.body;
    let sessionId = session_id;
    if (!sessionId || !sessions.has(sessionId)) {
      sessionId = crypto.randomUUID();
      sessions.set(sessionId, [{ role: 'user', parts: [{ text: systemPrompt }] }, { role: 'model', parts: [{ text: 'Understood.' }] }]);
    }

    const history = sessions.get(sessionId);
    const newHistory = [...history, { role: 'user', parts: [{ text: message }] }];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: session\ndata: ${sessionId}\n\n`);

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      const fallbackMsg = "I'm currently unable to connect to my AI brain (API key missing). Please WhatsApp us for assistance!";
      res.write(`data: ${fallbackMsg.replace(/\n/g, '\\n')}\n\n`);
      res.write(`event: done\ndata: done\n\n`);
      return res.end();
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${apiKey}&alt=sse`;

    const response = await axios({
      method: 'post',
      url,
      data: {
        contents: newHistory,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 250,
        }
      },
      responseType: 'stream'
    });

    let modelReply = '';
    let buffer = '';

    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
          try {
            const dataStr = line.slice(6);
            const parsed = JSON.parse(dataStr);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              modelReply += text;
              // replace newlines with literal '\n' for the frontend's SSE parser
              const sseSafeText = text.replace(/\n/g, '\\n');
              res.write(`data: ${sseSafeText}\n\n`);
            }
          } catch (e) {
            // Ignore parse errors on partial streams if any
          }
        }
      }
    });

    response.data.on('end', () => {
      history.push({ role: 'user', parts: [{ text: message }] });
      history.push({ role: 'model', parts: [{ text: modelReply }] });
      if (history.length > 10) history.splice(2, history.length - 10);
      sessions.set(sessionId, history);
      
      res.write(`event: done\ndata: done\n\n`);
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('Gemini Stream Error:', err.message);
      res.write(`event: error\ndata: API Error\n\n`);
      res.end();
    });

  } catch (error) {
    console.error('Chat Controller Error:', error.response?.data || error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process chat' });
    } else {
      res.write(`event: error\ndata: Internal Server Error\n\n`);
      res.end();
    }
  }
};

module.exports = {
  handleChat
};
