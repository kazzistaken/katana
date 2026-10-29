import { $, el } from './util.js';

/**
 * Small modal dialogs in #overlay: confirm, rename, choose. Each returns a
 * promise; Escape or a click outside cancels. Only one is open at a time.
 */

function open(card, onCancel) {
  const overlay = $('#overlay');
  const previous = document.activeElement;
  overlay.replaceChildren(card);
  overlay.hidden = false;
  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      onCancel();
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.onpointerdown = (event) => {
    if (event.target === overlay) {
      close();
      onCancel();
    }
  };
  return close;
}

export function confirmDialog({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let close = () => {};
    const done = (value) => {
      close();
      resolve(value);
    };
    const okButton = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: ok, onclick: () => done(true) });
    const card = el(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      el('h2', { class: 'dialog-title', id: 'dialog-title', text: title }),
      body ? el('p', { class: 'dialog-body', text: body }) : null,
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn', type: 'button', text: cancel, onclick: () => done(false) }), okButton)
    );
    close = open(card, () => resolve(false));
    okButton.focus();
  });
}

export function promptDialog({ title, value = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    let close = () => {};
    const input = el('input', { class: 'dialog-input', type: 'text', value, 'aria-label': title });
    const done = (result) => {
      close();
      resolve(result);
    };
    const form = el(
      'form',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      el('h2', { class: 'dialog-title', id: 'dialog-title', text: title }),
      input,
      el(
        'div',
        { class: 'dialog-actions' },
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => done(null) }),
        el('button', { class: 'btn btn-primary', type: 'submit', text: ok })
      )
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      done(input.value.trim() || null);
    });
    close = open(form, () => resolve(null));
    input.focus();
    input.select();
  });
}

/** Pick one of a few options; resolves its value, or null. */
export function chooseDialog({ title, options }) {
  return new Promise((resolve) => {
    let close = () => {};
    const done = (value) => {
      close();
      resolve(value);
    };
    const card = el(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      el('h2', { class: 'dialog-title', id: 'dialog-title', text: title }),
      el(
        'div',
        { class: 'dialog-choices' },
        options.map((option) =>
          el(
            'button',
            { class: 'dialog-choice', type: 'button', onclick: () => done(option.value) },
            el('span', { class: 'dialog-choice-label', text: option.label }),
            option.detail ? el('span', { class: 'dialog-choice-detail', text: option.detail }) : null
          )
        )
      ),
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => done(null) }))
    );
    close = open(card, () => resolve(null));
    card.querySelector('.dialog-choice')?.focus();
  });
}
