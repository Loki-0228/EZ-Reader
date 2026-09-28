import { exportWordCards } from './word-card.js';

export function downloadWordCards(cards, format = 'anki', doc = document) {
  const file = exportWordCards(cards, format);
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
  const link = doc.createElement('a');
  link.href = url; link.download = file.filename; link.hidden = true;
  doc.body.appendChild(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
