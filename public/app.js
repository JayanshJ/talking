(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    join: $('join'), chat: $('chat'),
    name: $('name'), room: $('room'), go: $('go'),
    roomTitle: $('roomTitle'), usersLine: $('usersLine'),
    messages: $('messages'), typing: $('typing'),
    form: $('form'), input: $('input'), send: $('send'),
    conn: $('connState'), leave: $('leave'), copyLink: $('copyLink'),
    avatar: $('avatar'),
  };

  const urlParams = new URLSearchParams(location.search);
  const urlRoom = urlParams.get('room');
  const savedRoom = localStorage.getItem('room');
  if (urlRoom) els.room.value = urlRoom;
  else if (savedRoom) els.room.value = savedRoom;
  const savedName = localStorage.getItem('name');
  if (savedName) els.name.value = savedName;

  let socket, myName, myRoom;
  let lastDay = null;
  let lastSender = null;
  let typingTimer = null;

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  function setConn(state) {
    els.conn.className = 'conn' + (state === 'bad' ? ' bad' : state === 'warn' ? ' warn' : '');
    els.conn.title = state === 'ok' ? 'connected' : state === 'warn' ? 'reconnecting…' : 'disconnected';
  }

  // stable per-name color bucket 1..8
  function tintFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return (Math.abs(h) % 8) + 1;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<]+)/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[1];
      frag.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function maybeDaySep(ts) {
    if (!ts) return;
    const day = new Date(ts).toDateString();
    if (day === lastDay) return;
    lastDay = day;
    lastSender = null; // reset grouping across day boundary
    const d = document.createElement('div');
    d.className = 'day-sep';
    const today = new Date().toDateString();
    const yest = new Date(Date.now() - 86400000).toDateString();
    d.textContent = day === today ? 'today' : day === yest ? 'yesterday' : dayFmt.format(new Date(ts));
    els.messages.appendChild(d);
  }

  function isAtBottom() {
    const m = els.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  function scroll(force) {
    const m = els.messages;
    if (force || isAtBottom()) m.scrollTop = m.scrollHeight;
  }

  function addMessage({ name, content, bot, self, ts }) {
    maybeDaySep(ts);

    const senderKey = bot ? 'grok' : name;
    const isFirst = senderKey !== lastSender;
    lastSender = senderKey;

    const wrap = document.createElement('div');
    wrap.className = 'msg' + (self ? ' self' : '') + (bot ? ' grok' : '') + (isFirst ? ' first' : '');

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (isFirst && !self) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = name;
      if (!bot) who.dataset.tint = String(tintFor(name));
      bubble.appendChild(who);
    }

    const text = document.createElement('div');
    text.className = 'text';
    text.appendChild(linkify(content));
    bubble.appendChild(text);

    if (ts) {
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = timeFmt.format(new Date(ts));
      bubble.appendChild(time);
    }

    wrap.appendChild(bubble);
    const wasAtBottom = isAtBottom();
    els.messages.appendChild(wrap);
    if (wasAtBottom || self) scroll(true);
  }

  function addSystem(text) {
    const d = document.createElement('div');
    d.className = 'system';
    d.textContent = text;
    els.messages.appendChild(d);
    lastSender = null; // break grouping
    scroll();
  }

  function showTyping(who) {
    if (!who) {
      els.typing.textContent = '';
      return;
    }
    els.typing.innerHTML = '';
    const label = document.createTextNode(who + ' is typing');
    const dots = document.createElement('span');
    dots.className = 'dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    els.typing.appendChild(label);
    els.typing.appendChild(dots);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => (els.typing.textContent = ''), 8000);
  }

  function setRoomUI(room) {
    els.roomTitle.textContent = '#' + room;
    els.avatar.textContent = (room[0] || '#').toUpperCase();
  }

  function connect() {
    socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 800 });

    socket.on('connect', () => {
      setConn('ok');
      socket.emit('join', { room: myRoom, name: myName });
    });
    socket.on('disconnect', () => setConn('bad'));
    socket.on('reconnect_attempt', () => setConn('warn'));
    socket.on('connect_error', () => setConn('bad'));

    socket.on('joined', ({ room, name, history, muted }) => {
      myName = name;
      myRoom = room;
      setRoomUI(room);
      els.messages.innerHTML = '';
      lastDay = null;
      lastSender = null;
      for (const m of history) {
        addMessage({ name: m.name, content: m.content, bot: m.bot, self: m.name === myName, ts: m.ts });
      }
      if (muted) addSystem('grok is muted in this room (/unmute to bring him back)');
      scroll(true);
    });
    socket.on('message', (m) => {
      addMessage({ name: m.name, content: m.content, bot: !!m.bot, self: m.name === myName, ts: m.ts });
      if (m.bot) showTyping('');
    });
    socket.on('system', (text) => addSystem(text));
    socket.on('users', (list) => {
      els.usersLine.textContent = `${list.length} online · ${list.join(', ')}`;
    });
    socket.on('typing', (who) => showTyping(who));
    socket.on('error-msg', (msg) => toast(msg));
  }

  function enter() {
    const name = els.name.value.trim() || 'anon';
    const room = (els.room.value.trim() || 'lobby').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!room) { toast('invalid room'); return; }
    localStorage.setItem('name', name);
    localStorage.setItem('room', room);
    myName = name;
    myRoom = room;
    history.replaceState(null, '', '?room=' + encodeURIComponent(room));
    els.join.hidden = true;
    els.chat.hidden = false;
    setRoomUI(room);
    els.input.focus();
    connect();
  }

  els.go.addEventListener('click', enter);
  els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.room.focus(); });
  els.room.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = els.input.value.trim();
    if (!v || !socket?.connected) return;
    socket.emit('message', v);
    els.input.value = '';
    els.input.focus();
  });

  document.querySelectorAll('.cmd').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!socket?.connected) return;
      socket.emit('message', btn.dataset.cmd);
    });
  });

  els.leave.addEventListener('click', () => {
    if (socket) socket.disconnect();
    localStorage.removeItem('room');
    history.replaceState(null, '', location.pathname);
    els.chat.hidden = true;
    els.join.hidden = false;
  });

  els.copyLink.addEventListener('click', async () => {
    const url = location.origin + '/?room=' + encodeURIComponent(myRoom);
    try {
      await navigator.clipboard.writeText(url);
      toast('link copied');
    } catch {
      prompt('copy this link', url);
    }
  });

  if (els.name.value.trim() && els.room.value.trim()) {
    enter();
  } else if (els.name.value) {
    els.room.focus();
  } else {
    els.name.focus();
  }
})();
