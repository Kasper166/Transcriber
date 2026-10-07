import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfToMarkdown } from './pdf-markdown.js';

function fixture(text) {
  const stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test('extracts real PDF text into Markdown with page headings', async () => {
  const result = await pdfToMarkdown(fixture('Instruction set architecture'), 'Lecture.pdf');
  assert.equal(result.pages, 1);
  assert.match(result.markdown, /^# Lecture/);
  assert.match(result.markdown, /## Page 1/);
  assert.match(result.markdown, /Instruction set architecture/);
});
test('rejects invalid documents and PDFs without selectable text', async () => {
  await assert.rejects(pdfToMarkdown(Buffer.from('bad')), /valid PDF/);
  await assert.rejects(pdfToMarkdown(fixture('')), /OCR/);
});
