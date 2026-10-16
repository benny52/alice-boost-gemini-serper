const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public resource IDs from the skill's uploaded recordings; these are not API keys.
const GREETINGS = [
  { id: '7ef4d4b4-7d2b-4b73-b7b4-d58720cdd134', text: 'Импортирую установки, начинаю калибровку виртуальной среды.' },
  { id: 'f2a36d8a-1c1a-4721-9f07-02260b2f9e21', text: 'Мы подключены и готовы.' },
  { id: '935124cd-41bd-4cb7-8784-5563e7292b4e', text: 'Всегда к вашим услугам, сэр.' }
];

export function launchGreeting(session) {
  if (session?.new !== true || typeof session.skill_id !== 'string' || !UUID.test(session.skill_id)) return null;
  const sound = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  return {
    text: sound.text,
    tts: '<speaker audio="dialogs-upload/' + session.skill_id + '/' + sound.id + '.opus">'
  };
}
