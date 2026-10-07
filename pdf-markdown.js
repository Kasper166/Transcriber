import { PDFParse } from 'pdf-parse';

export async function pdfToMarkdown(data, filename = 'document.pdf') {
  if (!Buffer.from(data).subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Choose a valid PDF file.');
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    const pages = result.pages;
    if (!pages.some(page => page.text.trim())) throw new Error('No selectable text found. Scanned PDFs need OCR, which this converter does not provide.');
    const title = filename.replace(/\.pdf$/i, '').replace(/[\r\n#]/g, ' ').trim() || 'Document';
    const markdown = `# ${title}\n\n` + pages.map((page, index) => {
      const text = page.text.trim().replace(/\r\n/g, '\n').replace(/^[ \t]*[•●▪][ \t]+/gm, '- ');
      return `## Page ${index + 1}\n\n${text || '*No selectable text on this page.*'}`;
    }).join('\n\n---\n\n');
    return { markdown, pages: pages.length };
  } finally { await parser.destroy(); }
}
