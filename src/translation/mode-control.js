import { TRANSLATION_MODES, translationMode, translationModePatch } from './config.js';

/** Native radios give the three-position switch keyboard and screen-reader behavior. */
export function createTranslationMode({ doc = document, onChange = () => {}, className = '' } = {}) {
  const element = doc.createElement('div');
  element.className = `ezr-translation-mode ${className}`.trim();
  element.setAttribute('role', 'radiogroup');
  element.setAttribute('aria-label', '划词与词卡模式');
  element.title = '划词翻译与泡泡词卡二选一；关闭词卡不影响全文翻译。';
  const name = `ezr-translation-mode-${crypto.randomUUID()}`;
  const inputs = TRANSLATION_MODES.map(([value, text]) => {
    const label = doc.createElement('label'), input = doc.createElement('input'), caption = doc.createElement('span');
    input.type = 'radio'; input.name = name; input.value = value;
    caption.textContent = text;
    input.addEventListener('change', () => { if (input.checked && !input.disabled) onChange(translationModePatch(value)); });
    label.append(input, caption); element.append(label);
    return input;
  });
  return {
    element,
    get value() { return inputs.find(input => input.checked)?.value || 'off'; },
    update(config, disabled = false) {
      for (const input of inputs) { input.checked = input.value === translationMode(config); input.disabled = disabled; }
    },
  };
}
