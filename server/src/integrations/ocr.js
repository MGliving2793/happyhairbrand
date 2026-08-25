const axios = require('axios');

/**
 * Extracts text from a base64 image using OCR.space API
 * @param {string} base64Image - The base64 string of the image (must include data:image/...;base64, prefix)
 * @returns {Promise<string>} - The extracted text
 */
const extractTextFromImage = async (base64Image) => {
  try {
    const apiKey = process.env.OCR_API_KEY || 'helloworld';
    
    // Ensure correct base64 formatting
    if (!base64Image.startsWith('data:image')) {
      base64Image = 'data:image/jpeg;base64,' + base64Image;
    }

    const formData = new URLSearchParams();
    formData.append('apikey', apiKey);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('base64Image', base64Image);
    formData.append('OCREngine', '2'); // Engine 2 is better for numbers and receipts

    const res = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000 // 15 second timeout for OCR
    });

    if (res.data && res.data.ParsedResults && res.data.ParsedResults.length > 0) {
      return res.data.ParsedResults[0].ParsedText || '';
    }

    return '';
  } catch (error) {
    console.error('[OCR ERROR]', error.message);
    return ''; // Return empty string on failure so we can either block or fallback
  }
};

/**
 * Verifies if the required amount exists in the extracted text
 * @param {string} extractedText - Text from the receipt
 * @param {number} requiredAmount - The total amount to look for
 * @returns {boolean}
 */
const verifyAmountInText = (extractedText, requiredAmount) => {
  if (!extractedText) return false;
  
  // Clean up the text (make lowercase, remove commas in numbers)
  const text = extractedText.toLowerCase().replace(/,/g, '');
  const amountStr = requiredAmount.toString();
  
  // Create variations of how the amount might appear
  // e.g. "499", "499.0", "499.00", "₹499", "rs499"
  const regexes = [
    new RegExp('(?:rs\\.?|₹|inr|paid)\\s*' + amountStr + '(?:\\.00?)?\\b', 'i'),
    new RegExp('\\b' + amountStr + '\\.00\\b', 'i'),
    new RegExp('₹\\s*' + amountStr + '\\b', 'i')
  ];

  // Check strict regexes first (like ₹499 or 499.00)
  for (let regex of regexes) {
    if (regex.test(text)) return true;
  }

  // Fallback: If the exact number appears as a standalone word/number in the text
  const standaloneRegex = new RegExp('\\b' + amountStr + '\\b');
  if (standaloneRegex.test(text)) return true;

  return false;
};

module.exports = {
  extractTextFromImage,
  verifyAmountInText
};
