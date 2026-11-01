/* =============================================================================
 * TCM BrewOps — Guest desk (thecaffeineministry.in, from the inside)
 * -----------------------------------------------------------------------------
 * Shared by owner.html ("Website & Bookings") and staff.html ("Guest Desk"),
 * so the floor team and the owner work from the same screen:
 *
 *   Orders        table and takeaway orders from the website, live, with a
 *                 chime for each new one
 *   Bookings      table reservations
 *   Stamps        loyalty cards: look up a number, add a stamp, redeem
 *   Feedback      "How was your visit?" answers            (owner only)
 *   Menu          edit and publish the QR menu             (owner only)
 *   Café details  hours, contact, booking/ordering/loyalty rules (owner only)
 *   QR codes      printable table codes                    (owner only)
 *
 * Loaded with <script type="text/babel" src="assets/tcm-guest.jsx">. It runs
 * as its own script, so everything is wrapped in a function and only
 * window.TCMGuest is exported; nothing here can collide with the page's own
 * top-level names (Icons, useState, …).
 *
 * The Firestore rules decide who may do what (the `guests` permission, and
 * owner-only for feedback and the public site documents). The tabs below
 * only mirror that.
 * ========================================================================== */
(function () {
    const { useState, useEffect, useRef } = React;
    const { db } = TCM;
    const FieldValue = firebase.firestore.FieldValue;

    const Ico = {
        Trash: () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
        Activity: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>,
        Users: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
        FileText: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>,
        Box: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>,
        Star: () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>
    };

    /** The same card as the owner dashboard's DashboardMetric. */
    function Metric({ title, value, subtitle, icon, borderColor = 'border-white/50' }) {
        return (
            <div className={`bg-white/80 backdrop-blur-xl p-5 rounded-2xl shadow-elegant border-t-4 ${borderColor} flex flex-col justify-between relative overflow-hidden`}>
                <div className="flex justify-between items-start mb-3"><p className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">{title}</p><div className="text-victorian bg-paperDark/50 p-2 rounded-lg">{icon}</div></div>
                <div><h3 className="text-3xl font-serif font-bold text-victorian tracking-tight">{value}</h3>{subtitle && <p className="text-[10px] text-brandBrown font-bold uppercase tracking-widest mt-2 bg-brandBrown/10 inline-block px-2 py-1 rounded">{subtitle}</p>}</div>
            </div>
        );
    }

    const me = () => { try { return (TCM.session() || {}).name || 'Owner'; } catch (e) { return 'Team'; } };
    const askFirst = (confirmAction) => confirmAction || ((msg, fn) => { if (window.confirm(msg)) fn(); });
    const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
    const ago = (ts) => {
        const ms = ts && ts.toMillis ? Date.now() - ts.toMillis() : 0;
        if (!ms) return 'just now';
        const m = Math.floor(ms / 60000);
        return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
    };
    const waLink = (phone, text) => `https://wa.me/${TCM.normalizePhone(phone)}${text ? '?text=' + encodeURIComponent(text) : ''}`;

    // Loyalty rules live in site/info (public). Mirrors LOYALTY_DEFAULTS in
    // functions/lib/guest.js.
    const LOYALTY_DEFAULTS = { enabled: true, stampsForReward: 9, reward: 'a coffee on us' };
    function useSiteInfo() {
        const [info, setInfo] = useState(null);
        useEffect(() => db.collection('site').doc('info').onSnapshot(
            s => setInfo(s.exists ? s.data() : {}), () => setInfo({})), []);
        return info;
    }
    const loyaltyOf = (info) => ({ ...LOYALTY_DEFAULTS, ...((info && info.loyalty) || {}) });

    /**
     * Add (or with a negative delta, take away) stamps on a card, creating the
     * card on its first stamp. A transaction, so two tills stamping the same
     * guest at once both count.
     */
    function changeStamps(phone, { delta = 1, name = '', redeem = 0, target = 9, note = '' }) {
        const id = TCM.normalizePhone(phone);
        if (!/^[1-9][0-9]{7,14}$/.test(id)) return Promise.reject(new Error('That does not look like a mobile number.'));
        const ref = db.collection('loyalty').doc(id);
        return db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const c = snap.exists ? snap.data() : { phone: id, name: '', stamps: 0, lifetime: 0, redeemed: 0, history: [] };
            const stamps = (Number(c.stamps) || 0) + delta - redeem * target;
            if (stamps < 0) throw new Error(redeem ? 'Not enough stamps for a reward yet.' : 'This card has no stamps to remove.');
            const next = {
                phone: id,
                name: String(name || c.name || '').trim().slice(0, 60),
                stamps,
                lifetime: (Number(c.lifetime) || 0) + Math.max(0, delta),
                redeemed: (Number(c.redeemed) || 0) + redeem,
                history: [{ at: Date.now(), d: delta - redeem * target, by: me(), note: String(note).slice(0, 40) }, ...(c.history || [])].slice(0, 20),
                updatedAt: FieldValue.serverTimestamp()
            };
            if (!snap.exists) next.createdAt = FieldValue.serverTimestamp();
            tx.set(ref, next);
            return next;
        });
    }

    // A short two-note chime for new orders. Browsers only allow sound after a
    // tap on the page, so the Orders tab has a "Sound on" button that unlocks it.
    let audio = null;
    function chime() {
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            [[880, 0], [1320, 0.18]].forEach(([f, t]) => {
                const o = audio.createOscillator(); const g = audio.createGain();
                o.frequency.value = f; o.type = 'sine';
                g.gain.setValueAtTime(0.0001, audio.currentTime + t);
                g.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.35);
                o.connect(g).connect(audio.destination);
                o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.4);
            });
        } catch (e) { /* no audio on this device */ }
    }

    const SITE_URL = 'https://thecaffeineministry.in';
    const RES_STATUSES = {
        pending:   { label: 'Awaiting reply', cls: 'bg-antiqueLight/60 text-victorian border-antique/40' },
        confirmed: { label: 'Confirmed',      cls: 'bg-vintageGreen/10 text-vintageGreen border-vintageGreen/30' },
        seated:    { label: 'Seated',         cls: 'bg-victorian text-paper border-victorian' },
        completed: { label: 'Completed',      cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        declined:  { label: 'Declined',       cls: 'bg-dangerLight text-danger border-danger/20' },
        cancelled: { label: 'Cancelled',      cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        'no-show': { label: 'No-show',        cls: 'bg-dangerLight text-danger border-danger/20' }
    };
    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const shiftDate = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const niceDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const niceTime = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`; };
    const newId = () => Math.random().toString(36).slice(2, 9);

    function ReservationsPanel({ bookings, loadError, showToast, confirmAction }) {
        const [filter, setFilter] = useState('upcoming');
        const today = istToday();
        const sorted = [...bookings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        const filters = {
            today:    b => b.date === today,
            upcoming: b => b.date >= today && !['declined', 'cancelled', 'completed', 'no-show'].includes(b.status),
            pending:  b => b.status === 'pending',
            past:     b => b.date < today || ['completed', 'no-show', 'declined', 'cancelled'].includes(b.status)
        };
        let shown = sorted.filter(filters[filter]);
        if (filter === 'past') shown = shown.reverse();
        const todayGuests = sorted.filter(b => b.date === today && ['pending', 'confirmed', 'seated'].includes(b.status)).reduce((s, b) => s + (Number(b.guests) || 0), 0);

        const setStatus = (b, status, extra = {}) =>
            db.collection('reservations').doc(b.docId)
                .update({ status, ...extra, updatedAt: FieldValue.serverTimestamp() })
                .then(() => showToast(`${b.name}: ${RES_STATUSES[status].label}`, 'success'))
                .catch(e => showToast(e.message, 'error'));

        const whatsapp = (b, kind) => {
            const when = `${niceDate(b.date)} at ${niceTime(b.time)}`;
            const text = kind === 'confirm'
                ? `Hello ${b.name}! Your table for ${b.guests} at The Caffeine Ministry on ${when} is confirmed. Booking ref ${b.ref}. We look forward to seeing you!`
                : `Hello ${b.name}, thank you for booking with The Caffeine Ministry. Unfortunately we are fully booked on ${when}. Could another time work for you? (Ref ${b.ref})`;
            window.open(`https://wa.me/${TCM.normalizePhone(b.phone)}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        };

        const setTable = (b) => {
            const t = window.prompt(`Table for ${b.name}:`, b.table || '');
            if (t === null) return;
            db.collection('reservations').doc(b.docId).update({ table: t.trim().slice(0, 12), updatedAt: FieldValue.serverTimestamp() })
                .catch(e => showToast(e.message, 'error'));
        };

        const btn = 'px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all';

        return (
            <div className="space-y-5">
                {loadError && <div className="bg-dangerLight text-danger border border-danger/20 rounded-xl p-4 text-sm">{loadError}</div>}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <Metric title="Awaiting reply" value={sorted.filter(filters.pending).length} subtitle="Need a yes or no" icon={<Ico.Activity/>} borderColor={sorted.some(filters.pending) ? 'border-antique' : 'border-gray-200'} />
                    <Metric title="Today" value={sorted.filter(b => b.date === today && !['declined', 'cancelled'].includes(b.status)).length} subtitle={`${todayGuests} guests expected`} icon={<Ico.Users/>} borderColor="border-vintageGreen" />
                    <Metric title="Upcoming" value={sorted.filter(filters.upcoming).length} subtitle="From today on" icon={<Ico.FileText/>} borderColor="border-brandBrown" />
                    <Metric title="No-shows" value={sorted.filter(b => b.status === 'no-show').length} subtitle="Past 7 days" icon={<Ico.Box/>} borderColor="border-gray-200" />
                </div>
                <div className="flex flex-wrap gap-2">
                    {[['upcoming', 'Upcoming'], ['today', 'Today'], ['pending', 'Awaiting reply'], ['past', 'Past week']].map(([id, label]) => (
                        <button key={id} onClick={() => setFilter(id)} className={`${btn} ${filter === id ? 'bg-brandBrown text-white border-brandBrown' : 'bg-white text-gray-600 border-gray-200'}`}>{label}</button>
                    ))}
                </div>
                {shown.length === 0 && <div className="bg-white/70 rounded-2xl p-10 text-center text-sm text-gray-500 border border-white/50">Nothing here. Bookings made on the website appear the moment they are sent.</div>}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {shown.map(b => {
                        const st = RES_STATUSES[b.status] || RES_STATUSES.pending;
                        return (
                            <div key={b.docId} className={`bg-white/90 backdrop-blur-xl p-5 rounded-2xl shadow-elegant border ${b.status === 'pending' ? 'border-antique animate-alert-flash' : 'border-white/50'}`}>
                                <div className="flex justify-between items-start gap-3 mb-3">
                                    <div>
                                        <p className="font-serif text-lg font-bold text-victorian leading-tight">{b.name}</p>
                                        <p className="text-xs text-gray-500 mt-1 font-mono">{b.ref}</p>
                                    </div>
                                    <span className={`text-[9px] uppercase font-bold tracking-widest px-2.5 py-1 rounded-lg border whitespace-nowrap ${st.cls}`}>{st.label}</span>
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-center mb-3">
                                    <div className="bg-paper rounded-xl py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">Date</p><p className="text-sm font-bold text-victorian">{niceDate(b.date)}</p></div>
                                    <div className="bg-paper rounded-xl py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">Time</p><p className="text-sm font-bold text-victorian">{niceTime(b.time)}</p></div>
                                    <div className="bg-paper rounded-xl py-2"><p className="text-[9px] uppercase tracking-widest text-gray-400 font-bold">Guests</p><p className="text-sm font-bold text-victorian">{b.guests}</p></div>
                                </div>
                                <div className="text-sm text-gray-700 space-y-1 mb-4">
                                    <p><a className="font-semibold text-brandBrown" href={`tel:+${b.phone}`}>+{b.phone}</a>{b.email ? <span className="text-gray-500"> · {b.email}</span> : null}</p>
                                    {b.occasion && <p><span className="text-gray-400">Occasion:</span> {b.occasion}</p>}
                                    {b.notes && <p className="bg-paper/80 rounded-lg px-3 py-2 italic">“{b.notes}”</p>}
                                    {b.table && <p><span className="text-gray-400">Table:</span> <b>{b.table}</b></p>}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {b.status === 'pending' && <>
                                        <button className={`${btn} bg-vintageGreen text-white border-vintageGreen`} onClick={() => { setStatus(b, 'confirmed'); whatsapp(b, 'confirm'); }}>Confirm + WhatsApp</button>
                                        <button className={`${btn} bg-white text-vintageGreen border-vintageGreen/40`} onClick={() => setStatus(b, 'confirmed')}>Confirm only</button>
                                        <button className={`${btn} bg-white text-danger border-danger/30`} onClick={() => confirmAction(`Decline ${b.name}'s booking?`, () => { setStatus(b, 'declined'); whatsapp(b, 'decline'); })}>Decline</button>
                                    </>}
                                    {b.status === 'confirmed' && <>
                                        <button className={`${btn} bg-victorian text-paper border-victorian`} onClick={() => setStatus(b, 'seated')}>Seated</button>
                                        <button className={`${btn} bg-white text-danger border-danger/30`} onClick={() => setStatus(b, 'no-show')}>No-show</button>
                                        <button className={`${btn} bg-white text-gray-500 border-gray-200`} onClick={() => confirmAction(`Cancel ${b.name}'s booking?`, () => setStatus(b, 'cancelled'))}>Cancel</button>
                                    </>}
                                    {b.status === 'seated' && <button className={`${btn} bg-white text-gray-600 border-gray-200`} onClick={() => setStatus(b, 'completed')}>Completed</button>}
                                    {['pending', 'confirmed', 'seated'].includes(b.status) && <button className={`${btn} bg-white text-victorian border-gray-200`} onClick={() => setTable(b)}>{b.table ? 'Change table' : 'Assign table'}</button>}
                                    <a className={`${btn} bg-white text-[#128C7E] border-[#25D366]/40`} href={`https://wa.me/${TCM.normalizePhone(b.phone)}`} target="_blank" rel="noopener">WhatsApp</a>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    function MenuEditor({ recipes, showToast, confirmAction }) {
        const [menu, setMenu] = useState(null);
        const [dirty, setDirty] = useState(false);
        const [busy, setBusy] = useState(false);
        const [openCat, setOpenCat] = useState(null);

        useEffect(() => {
            db.collection('site').doc('menu').get().then(snap => {
                const m = snap.exists ? snap.data() : {};
                setMenu({ currency: m.currency || '₹', footnote: m.footnote || 'Prices are in Indian rupees and include GST.', categories: m.categories || [] });
                setOpenCat(((m.categories || [])[0] || {}).id || null);
            }).catch(e => showToast(e.message, 'error'));
        }, []);

        if (!menu) return <div className="text-sm text-gray-500 p-6">Loading the menu…</div>;

        const change = (fn) => { setMenu(m => { const next = JSON.parse(JSON.stringify(m)); fn(next); return next; }); setDirty(true); };
        const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; };

        const addCategory = () => { const name = window.prompt('Section name (e.g. Cold Coffee):'); if (!name || !name.trim()) return; const id = newId(); change(m => m.categories.push({ id, name: name.trim(), note: '', items: [] })); setOpenCat(id); };
        const addItem = (ci) => change(m => m.categories[ci].items.push({ id: newId(), name: '', desc: '', price: '', veg: true, tags: [], available: true }));

        // Pull dish names from the recipe book into matching sections. Names
        // only: recipes hold cost data, which must never reach this public document.
        const importRecipes = () => {
            const bySection = { Beverages: 'Beverages', Kitchen: 'Kitchen', Desserts: 'Desserts' };
            const existing = new Set(menu.categories.flatMap(c => c.items.map(i => (i.name || '').trim().toLowerCase())));
            const fresh = (recipes || []).filter(r => bySection[r.category] && r.name && !existing.has(r.name.trim().toLowerCase()));
            if (!fresh.length) return showToast('Every recipe is already on the menu', 'info');
            change(m => {
                fresh.forEach(r => {
                    let cat = m.categories.find(c => c.name === bySection[r.category]);
                    if (!cat) { cat = { id: newId(), name: bySection[r.category], note: '', items: [] }; m.categories.push(cat); }
                    cat.items.push({ id: newId(), name: r.name.trim(), desc: '', price: '', veg: true, tags: [], available: true });
                });
            });
            showToast(`Added ${fresh.length} dishes. Add prices, then publish.`, 'success');
        };

        const publish = () => {
            const problems = [];
            menu.categories.forEach(c => { if (!c.name.trim()) problems.push('A section has no name'); c.items.forEach(i => { if (!i.name.trim()) problems.push(`An item in ${c.name || 'a section'} has no name`); }); });
            if (problems.length) return showToast(problems[0], 'error');
            const clean = {
                currency: menu.currency || '₹',
                footnote: (menu.footnote || '').trim().slice(0, 300),
                categories: menu.categories.map(c => ({
                    id: c.id, name: c.name.trim().slice(0, 60), note: (c.note || '').trim().slice(0, 200), hidden: !!c.hidden,
                    items: c.items.map(i => ({
                        id: i.id, name: i.name.trim().slice(0, 80), desc: (i.desc || '').trim().slice(0, 200),
                        price: i.price === '' || i.price === null ? null : Number(i.price),
                        veg: i.veg === true ? true : i.veg === false ? false : null,
                        tags: (i.tags || []).filter(Boolean), available: i.available !== false, hidden: !!i.hidden
                    }))
                })),
                updatedAt: FieldValue.serverTimestamp()
            };
            setBusy(true);
            db.collection('site').doc('menu').set(clean)
                .then(() => { setDirty(false); showToast('Menu published to the website', 'success'); })
                .catch(e => showToast(e.code === 'permission-denied' ? 'Not allowed. Deploy the updated firestore.rules first.' : e.message, 'error'))
                .then(() => setBusy(false));
        };

        const input = 'w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm';
        const count = menu.categories.reduce((s, c) => s + c.items.length, 0);

        return (
            <div className="space-y-4">
                <div className="bg-white/90 backdrop-blur-xl p-4 rounded-2xl shadow-elegant border border-white/50 flex flex-wrap items-center gap-3 sticky top-28 z-20">
                    <p className="text-sm text-gray-600 flex-1 min-w-[200px]">{menu.categories.length} sections · {count} items{dirty ? <span className="ml-2 text-danger font-bold">· Unpublished changes</span> : <span className="ml-2 text-vintageGreen font-bold">· Live</span>}</p>
                    <button onClick={importRecipes} className="px-4 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border border-gray-200 bg-white text-victorian">Import from recipe book</button>
                    <button onClick={addCategory} className="px-4 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border border-gray-200 bg-white text-victorian">+ Section</button>
                    <button onClick={publish} disabled={busy || !dirty} className="px-5 py-2.5 rounded-xl text-[10px] font-bold uppercase tracking-widest bg-antique text-victorian shadow-md disabled:opacity-40">{busy ? 'Publishing…' : 'Publish'}</button>
                </div>
                {!menu.categories.length && <div className="bg-white/70 rounded-2xl p-8 text-center text-sm text-gray-600 border border-white/50">No menu published yet, so the website is showing its built-in sample menu. Add sections, or import your recipe names, then publish.</div>}
                {menu.categories.map((c, ci) => (
                    <div key={c.id} className="bg-white/90 backdrop-blur-xl rounded-2xl shadow-elegant border border-white/50 overflow-hidden">
                        <div className="flex items-center gap-2 p-4 cursor-pointer" onClick={() => setOpenCat(openCat === c.id ? null : c.id)}>
                            <span className="text-brandBrown font-bold w-4">{openCat === c.id ? '−' : '+'}</span>
                            <p className={`font-serif text-lg font-bold flex-1 ${c.hidden ? 'text-gray-400 line-through' : 'text-victorian'}`}>{c.name || 'Untitled section'} <span className="text-xs font-sans font-normal text-gray-400">({c.items.length})</span></p>
                            <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                                <button title="Move up" className="px-2 py-1 text-gray-400 hover:text-victorian" onClick={() => change(m => move(m.categories, ci, -1))}>↑</button>
                                <button title="Move down" className="px-2 py-1 text-gray-400 hover:text-victorian" onClick={() => change(m => move(m.categories, ci, 1))}>↓</button>
                            </div>
                        </div>
                        {openCat === c.id && (
                            <div className="border-t border-gray-100 p-4 space-y-3 bg-paper/40">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <input className={input} value={c.name} placeholder="Section name" onChange={e => { const v = e.target.value; change(m => { m.categories[ci].name = v; }); }} />
                                    <input className={input} value={c.note || ''} placeholder="Note under the heading (optional)" onChange={e => { const v = e.target.value; change(m => { m.categories[ci].note = v; }); }} />
                                </div>
                                {c.items.map((it, ii) => {
                                    const setI = (k, v) => change(m => { m.categories[ci].items[ii][k] = v; });
                                    const tag = (t) => (it.tags || []).includes(t);
                                    const toggleTag = (t) => change(m => { const tg = m.categories[ci].items[ii].tags || []; m.categories[ci].items[ii].tags = tg.includes(t) ? tg.filter(x => x !== t) : [...tg, t]; });
                                    return (
                                        <div key={it.id} className={`bg-white rounded-xl border p-3 space-y-2 ${it.available === false ? 'border-danger/30' : 'border-gray-200'}`}>
                                            <div className="grid grid-cols-12 gap-2">
                                                <input className={`${input} col-span-8 font-semibold`} value={it.name} placeholder="Item name" onChange={e => setI('name', e.target.value)} />
                                                <div className="col-span-4 relative"><span className="absolute left-3 top-2 text-sm text-gray-400">₹</span><input className={`${input} pl-6`} type="number" min="0" inputMode="numeric" value={it.price ?? ''} placeholder="Price" onChange={e => setI('price', e.target.value)} /></div>
                                                <input className={`${input} col-span-12`} value={it.desc || ''} placeholder="Short description (optional)" onChange={e => setI('desc', e.target.value)} />
                                            </div>
                                            <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
                                                <select className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white" value={it.veg === true ? 'veg' : it.veg === false ? 'nonveg' : 'none'} onChange={e => setI('veg', e.target.value === 'veg' ? true : e.target.value === 'nonveg' ? false : null)}>
                                                    <option value="veg">Veg</option><option value="nonveg">Non-veg</option><option value="none">No mark</option>
                                                </select>
                                                {['Signature', 'New'].map(t => <button key={t} onClick={() => toggleTag(t)} className={`px-2.5 py-1.5 rounded-lg border ${tag(t) ? 'bg-antique/30 border-antique text-victorian' : 'bg-white border-gray-200 text-gray-400'}`}>{t}</button>)}
                                                <button onClick={() => setI('available', it.available === false)} className={`px-2.5 py-1.5 rounded-lg border ${it.available === false ? 'bg-dangerLight border-danger/30 text-danger' : 'bg-white border-gray-200 text-vintageGreen'}`}>{it.available === false ? 'Sold out' : 'Available'}</button>
                                                <span className="flex-1"></span>
                                                <button title="Move up" className="px-2 text-gray-400 hover:text-victorian" onClick={() => change(m => move(m.categories[ci].items, ii, -1))}>↑</button>
                                                <button title="Move down" className="px-2 text-gray-400 hover:text-victorian" onClick={() => change(m => move(m.categories[ci].items, ii, 1))}>↓</button>
                                                <button title="Remove" className="px-2 text-danger/60 hover:text-danger" onClick={() => change(m => { m.categories[ci].items.splice(ii, 1); })}><Ico.Trash/></button>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div className="flex flex-wrap gap-2 pt-1">
                                    <button onClick={() => addItem(ci)} className="px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-victorian text-paper">+ Item</button>
                                    <button onClick={() => change(m => { m.categories[ci].hidden = !m.categories[ci].hidden; })} className="px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border border-gray-200 bg-white text-gray-600">{c.hidden ? 'Show section' : 'Hide section'}</button>
                                    <button onClick={() => confirmAction(`Delete the whole "${c.name}" section?`, () => change(m => { m.categories.splice(ci, 1); }))} className="px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border border-danger/30 bg-white text-danger">Delete section</button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
                <div className="bg-white/90 rounded-2xl p-4 border border-white/50 shadow-elegant">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Note at the bottom of the menu</label>
                    <input className={`${input} mt-2`} value={menu.footnote} onChange={e => { const v = e.target.value; change(m => { m.footnote = v; }); }} />
                </div>
            </div>
        );
    }

    // Declared out here, not inside SiteInfoEditor: a component defined during
    // render is a new type every keystroke, so its input would lose focus.
    function F({ label, hint, children }) {
        return (<div><label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1.5">{label}</label>{children}{hint && <p className="text-[11px] text-gray-400 mt-1">{hint}</p>}</div>);
    }

    function SiteInfoEditor({ showToast }) {
        const blank = { tagline: '', address: '', mapsQuery: '', phone: '', whatsapp: '', email: '', instagram: '', open: '09:00', close: '23:00', closedWeekdays: [], hoursNote: '', announcement: '', googleReviewUrl: '',
                        ordering: { tableEnabled: true, takeawayEnabled: true, prepMinutes: 20 },
                        loyalty: { ...LOYALTY_DEFAULTS },
                        reservations: { enabled: true, maxGuests: 12, slotMinutes: 30, lastSeatingMinutes: 60, daysAhead: 30, leadMinutes: 30, closedDates: [] } };
        const [info, setInfo] = useState(null);
        const [busy, setBusy] = useState(false);

        useEffect(() => {
            db.collection('site').doc('info').get().then(snap => {
                const d = snap.exists ? snap.data() : {};
                setInfo({ ...blank, ...d, reservations: { ...blank.reservations, ...(d.reservations || {}) },
                          ordering: { ...blank.ordering, ...(d.ordering || {}) }, loyalty: { ...blank.loyalty, ...(d.loyalty || {}) } });
            }).catch(e => showToast(e.message, 'error'));
        }, []);
        if (!info) return <div className="text-sm text-gray-500 p-6">Loading…</div>;

        const set = (k, v) => setInfo(i => ({ ...i, [k]: v }));
        const setR = (k, v) => setInfo(i => ({ ...i, reservations: { ...i.reservations, [k]: v } }));
        const setO = (k, v) => setInfo(i => ({ ...i, ordering: { ...i.ordering, [k]: v } }));
        const setL = (k, v) => setInfo(i => ({ ...i, loyalty: { ...i.loyalty, [k]: v } }));

        const save = () => {
            if (info.close <= info.open) return showToast('Closing time must be after opening time', 'error');
            const review = String(info.googleReviewUrl || '').trim();
            if (review && !/^https:\/\//.test(review)) return showToast('The Google review link must start with https://', 'error');
            const stampsFor = Number(info.loyalty.stampsForReward);
            if (!Number.isInteger(stampsFor) || stampsFor < 3 || stampsFor > 30) return showToast('Stamps for a reward must be between 3 and 30', 'error');
            const r = info.reservations;
            const out = {
                ...['tagline', 'address', 'mapsQuery', 'phone', 'whatsapp', 'email', 'instagram', 'hoursNote', 'announcement']
                    .reduce((o, k) => ({ ...o, [k]: String(info[k] || '').trim().slice(0, 300) }), {}),
                open: info.open, close: info.close,
                closedWeekdays: info.closedWeekdays.map(Number),
                reservations: {
                    enabled: !!r.enabled, maxGuests: Number(r.maxGuests) || 12, slotMinutes: Number(r.slotMinutes) || 30,
                    lastSeatingMinutes: Number(r.lastSeatingMinutes) || 0, daysAhead: Number(r.daysAhead) || 30,
                    leadMinutes: Number(r.leadMinutes) || 0,
                    closedDates: (Array.isArray(r.closedDates) ? r.closedDates : String(r.closedDates).split(','))
                        .map(s => String(s).trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
                },
                googleReviewUrl: review.slice(0, 300),
                ordering: {
                    tableEnabled: !!info.ordering.tableEnabled, takeawayEnabled: !!info.ordering.takeawayEnabled,
                    prepMinutes: Math.min(180, Math.max(5, Number(info.ordering.prepMinutes) || 20))
                },
                loyalty: { enabled: !!info.loyalty.enabled, stampsForReward: stampsFor, reward: String(info.loyalty.reward || '').trim().slice(0, 80) || LOYALTY_DEFAULTS.reward },
                updatedAt: FieldValue.serverTimestamp()
            };
            setBusy(true);
            db.collection('site').doc('info').set(out)
                .then(() => showToast('Café details saved. The website updates within a few minutes.', 'success'))
                .catch(e => showToast(e.code === 'permission-denied' ? 'Not allowed. Deploy the updated firestore.rules first.' : e.message, 'error'))
                .then(() => setBusy(false));
        };

        const input = 'w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm';
        const card = 'bg-white/90 backdrop-blur-xl p-6 rounded-2xl shadow-elegant border border-white/50 space-y-4';

        return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className={card}>
                    <h3 className="font-serif text-xl text-victorian">Contact &amp; location</h3>
                    <F label="Phone" hint="Shown on the website as a tap-to-call link."><input className={input} value={info.phone} onChange={e => set('phone', e.target.value)} placeholder="98xxxxxxxx" /></F>
                    <F label="WhatsApp number" hint="Adds the green WhatsApp button and receives event enquiries."><input className={input} value={info.whatsapp} onChange={e => set('whatsapp', e.target.value)} placeholder="98xxxxxxxx" /></F>
                    <F label="Email"><input className={input} value={info.email} onChange={e => set('email', e.target.value)} placeholder="hello@thecaffeineministry.in" /></F>
                    <F label="Instagram"><input className={input} value={info.instagram} onChange={e => set('instagram', e.target.value)} placeholder="@thecaffeineministry" /></F>
                    <F label="Address"><input className={input} value={info.address} onChange={e => set('address', e.target.value)} placeholder="'Parasudai', 672, 12th C Road, Sardarpura, Jodhpur" /></F>
                    <F label="Google Maps search" hint="What the directions button searches for. The café's name on Google Maps works best."><input className={input} value={info.mapsQuery} onChange={e => set('mapsQuery', e.target.value)} placeholder="The Caffeine Ministry, Sardarpura, Jodhpur" /></F>
                    <F label="Google review link" hint="Happy guests (4–5 stars) are invited to post a review here. In Google Business Profile: Ask for reviews → copy the link."><input className={input} value={info.googleReviewUrl} onChange={e => set('googleReviewUrl', e.target.value)} placeholder="https://g.page/r/…/review" /></F>
                    <F label="Tagline"><input className={input} value={info.tagline} onChange={e => set('tagline', e.target.value)} placeholder="Specialty coffee & all-day plates in Sardarpura, Jodhpur" /></F>
                </div>
                <div className="space-y-6">
                    <div className={card}>
                        <h3 className="font-serif text-xl text-victorian">Opening hours</h3>
                        <div className="grid grid-cols-2 gap-3">
                            <F label="Opens"><input type="time" className={input} value={info.open} onChange={e => set('open', e.target.value)} /></F>
                            <F label="Closes"><input type="time" className={input} value={info.close} onChange={e => set('close', e.target.value)} /></F>
                        </div>
                        <F label="Closed on">
                            <div className="flex flex-wrap gap-2">{WEEKDAYS.map((d, i) => { const on = info.closedWeekdays.includes(i); return <button key={d} onClick={() => set('closedWeekdays', on ? info.closedWeekdays.filter(x => x !== i) : [...info.closedWeekdays, i])} className={`px-3 py-2 rounded-lg text-xs font-bold border ${on ? 'bg-danger text-white border-danger' : 'bg-white text-gray-600 border-gray-200'}`}>{d}</button>; })}</div>
                        </F>
                        <F label="Hours note (optional)"><input className={input} value={info.hoursNote} onChange={e => set('hoursNote', e.target.value)} placeholder="Kitchen closes 30 minutes before the café" /></F>
                        <F label="Announcement bar (optional)" hint="A strip across the top of every page. Leave empty to hide it."><input className={input} value={info.announcement} onChange={e => set('announcement', e.target.value)} placeholder="Closed on 1 Nov for a private event" /></F>
                    </div>
                    <div className={card}>
                        <div className="flex items-center justify-between"><h3 className="font-serif text-xl text-victorian">Online booking</h3>
                            <button onClick={() => setR('enabled', !info.reservations.enabled)} className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest ${info.reservations.enabled ? 'bg-vintageGreen text-white' : 'bg-gray-200 text-gray-600'}`}>{info.reservations.enabled ? 'On' : 'Paused'}</button></div>
                        <div className="grid grid-cols-2 gap-3">
                            <F label="Largest party"><input type="number" min="1" max="100" className={input} value={info.reservations.maxGuests} onChange={e => setR('maxGuests', e.target.value)} /></F>
                            <F label="Slot every"><select className={input} value={info.reservations.slotMinutes} onChange={e => setR('slotMinutes', Number(e.target.value))}><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option></select></F>
                            <F label="Last booking (min before close)"><input type="number" min="0" max="240" className={input} value={info.reservations.lastSeatingMinutes} onChange={e => setR('lastSeatingMinutes', e.target.value)} /></F>
                            <F label="Same-day notice (min)"><input type="number" min="0" max="1440" className={input} value={info.reservations.leadMinutes} onChange={e => setR('leadMinutes', e.target.value)} /></F>
                            <F label="Book up to (days ahead)"><input type="number" min="1" max="180" className={input} value={info.reservations.daysAhead} onChange={e => setR('daysAhead', e.target.value)} /></F>
                        </div>
                        <F label="Closed dates" hint="Comma-separated, e.g. 2026-11-01, 2026-12-25"><input className={input} value={Array.isArray(info.reservations.closedDates) ? info.reservations.closedDates.join(', ') : info.reservations.closedDates} onChange={e => setR('closedDates', e.target.value)} /></F>
                    </div>
                    <div className={card}>
                        <h3 className="font-serif text-xl text-victorian">Ordering from the website</h3>
                        <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Order from the table (QR code)</span><button onClick={() => setO('tableEnabled', !info.ordering.tableEnabled)} className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest ${info.ordering.tableEnabled ? 'bg-vintageGreen text-white' : 'bg-gray-200 text-gray-600'}`}>{info.ordering.tableEnabled ? 'On' : 'Paused'}</button></div>
                        <div className="flex items-center justify-between"><span className="text-sm text-gray-700">Takeaway pre-orders</span><button onClick={() => setO('takeawayEnabled', !info.ordering.takeawayEnabled)} className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest ${info.ordering.takeawayEnabled ? 'bg-vintageGreen text-white' : 'bg-gray-200 text-gray-600'}`}>{info.ordering.takeawayEnabled ? 'On' : 'Paused'}</button></div>
                        <F label="Takeaway preparation time (min)" hint="The earliest pickup is this long from when the guest orders."><input type="number" min="5" max="180" className={input} value={info.ordering.prepMinutes} onChange={e => setO('prepMinutes', e.target.value)} /></F>
                    </div>
                    <div className={card}>
                        <div className="flex items-center justify-between"><h3 className="font-serif text-xl text-victorian">Rewards card</h3><button onClick={() => setL('enabled', !info.loyalty.enabled)} className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest ${info.loyalty.enabled ? 'bg-vintageGreen text-white' : 'bg-gray-200 text-gray-600'}`}>{info.loyalty.enabled ? 'On' : 'Paused'}</button></div>
                        <div className="grid grid-cols-2 gap-3">
                            <F label="Stamps for a reward"><input type="number" min="3" max="30" className={input} value={info.loyalty.stampsForReward} onChange={e => setL('stampsForReward', e.target.value)} /></F>
                            <F label="The reward"><input className={input} value={info.loyalty.reward} onChange={e => setL('reward', e.target.value)} placeholder="a coffee on us" /></F>
                        </div>
                        <p className="text-[11px] text-gray-400">Shown to guests as “Collect 9 and you'll get a coffee on us”.</p>
                    </div>
                    <button onClick={save} disabled={busy} className="w-full bg-antique text-victorian py-4 rounded-2xl text-xs font-bold uppercase tracking-widest shadow-md disabled:opacity-50">{busy ? 'Saving…' : 'Save café details'}</button>
                </div>
            </div>
        );
    }


    const ORDER_FLOW = {
        new:       { label: 'New',         cls: 'bg-antique text-victorian border-antique' },
        preparing: { label: 'Being made',  cls: 'bg-brandBrown/10 text-brandBrown border-brandBrown/30' },
        ready:     { label: 'Ready',       cls: 'bg-vintageGreen/10 text-vintageGreen border-vintageGreen/30' },
        served:    { label: 'Served',      cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        collected: { label: 'Collected',   cls: 'bg-gray-100 text-gray-500 border-gray-200' },
        cancelled: { label: 'Cancelled',   cls: 'bg-dangerLight text-danger border-danger/20' }
    };
    const DONE = ['served', 'collected', 'cancelled'];

    /**
     * Guest desk. `isOwner` adds the owner-only tabs; everyone with the
     * `guests` permission gets orders, bookings and stamps.
     */
    function GuestDesk({ isOwner, recipes, showToast, confirmAction }) {
        const toast = showToast || ((m) => console.log(m));
        const confirm = askFirst(confirmAction);
        const [tab, setTab] = useState('orders');
        const [bookings, setBookings] = useState([]);
        const [bookingError, setBookingError] = useState('');
        const [orders, setOrders] = useState([]);
        const [orderError, setOrderError] = useState('');
        const [unresolved, setUnresolved] = useState(0);
        const [sound, setSound] = useState(false);
        const soundRef = useRef(false);
        const seen = useRef(null);
        const info = useSiteInfo();

        const denied = (what) => (err) => err.code === 'permission-denied'
            ? `${what} are not readable yet. Deploy the updated firestore.rules (npm run deploy:rules).`
            : err.message;

        useEffect(() => {
            const from = shiftDate(istToday(), -7);
            return db.collection('reservations').where('date', '>=', from).orderBy('date').onSnapshot(
                snap => { setBookings(snap.docs.map(d => ({ docId: d.id, ...d.data() }))); setBookingError(''); },
                err => setBookingError(denied('Reservations')(err)));
        }, []);

        // Today's orders, live. The first snapshot is history; anything new
        // after that chimes and shows a toast.
        useEffect(() => {
            return db.collection('orders').where('date', '==', istToday()).onSnapshot(snap => {
                const list = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
                if (seen.current) {
                    const fresh = list.filter(o => o.status === 'new' && !seen.current.has(o.docId));
                    if (fresh.length) {
                        if (soundRef.current) chime();
                        fresh.forEach(o => toast(`New order ${o.code}: ${o.type === 'table' ? 'Table ' + o.table : 'Pickup ' + niceTime(o.pickupTime)}`, 'success'));
                    }
                }
                seen.current = new Set(list.map(o => o.docId));
                setOrders(list);
                setOrderError('');
            }, err => setOrderError(denied('Orders')(err)));
        }, []);

        useEffect(() => {
            if (!isOwner) return;
            return db.collection('feedback').where('resolved', '==', false).onSnapshot(
                s => setUnresolved(s.size), () => {});
        }, [isOwner]);

        // Keep the browser tab title honest about what is waiting.
        const waitingOrders = orders.filter(o => o.status === 'new').length;
        useEffect(() => {
            const base = document.title.replace(/^\(\d+\) /, '');
            document.title = waitingOrders ? `(${waitingOrders}) ${base}` : base;
        }, [waitingOrders]);

        const pending = bookings.filter(b => b.status === 'pending').length;
        const tabs = [
            { id: 'orders', label: 'Orders', badge: waitingOrders },
            { id: 'bookings', label: 'Bookings', badge: pending },
            { id: 'stamps', label: 'Stamps' },
            ...(isOwner ? [
                { id: 'feedback', label: 'Feedback', badge: unresolved },
                { id: 'menu', label: 'Menu' },
                { id: 'info', label: 'Café details' },
                { id: 'qr', label: 'QR codes' }
            ] : [])
        ];

        const toggleSound = () => {
            soundRef.current = !soundRef.current;
            setSound(soundRef.current);
            if (soundRef.current) chime();
        };

        return (
            <div className="animate-fade-in space-y-6 pb-16">
                <div className="flex flex-wrap justify-between items-end gap-3">
                    <h2 className="text-2xl font-serif font-bold text-victorian drop-shadow-sm border-b-2 border-brandBrown/30 pb-2 inline-block">{isOwner ? 'Website & Guests' : 'Guest Desk'}</h2>
                    <div className="flex items-center gap-3">
                        <button onClick={toggleSound} className={`px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border ${sound ? 'bg-vintageGreen text-white border-vintageGreen' : 'bg-white text-gray-500 border-gray-200'}`}>{sound ? '🔔 Sound on' : '🔕 Sound off'}</button>
                        <a href={SITE_URL} target="_blank" rel="noopener" className="text-xs font-bold uppercase tracking-widest text-brandBrown hover:text-victorian">thecaffeineministry.in ↗</a>
                    </div>
                </div>
                <div className="flex gap-2 overflow-x-auto hide-scrollbar">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest whitespace-nowrap transition-all border ${tab === t.id ? 'bg-victorian text-paper border-victorian shadow-md' : 'bg-white/80 text-victorian border-gray-200 hover:border-brandBrown/40'}`}>
                            {t.label}{t.badge ? <span className="ml-2 bg-antique text-victorian rounded-full px-2 py-0.5">{t.badge}</span> : null}
                        </button>
                    ))}
                </div>
                {tab === 'orders' && <OrdersPanel orders={orders} loadError={orderError} info={info} showToast={toast} confirmAction={confirm} />}
                {tab === 'bookings' && <ReservationsPanel bookings={bookings} loadError={bookingError} showToast={toast} confirmAction={confirm} />}
                {tab === 'stamps' && <StampsPanel info={info} showToast={toast} confirmAction={confirm} />}
                {isOwner && tab === 'feedback' && <FeedbackPanel showToast={toast} />}
                {isOwner && tab === 'menu' && <MenuEditor recipes={recipes} showToast={toast} confirmAction={confirm} />}
                {isOwner && tab === 'info' && <SiteInfoEditor showToast={toast} />}
                {isOwner && tab === 'qr' && (
                    <div className="bg-white/80 backdrop-blur-xl p-6 rounded-2xl shadow-elegant border border-white/50 space-y-4 max-w-2xl">
                        <h3 className="font-serif text-xl text-victorian">Table QR codes</h3>
                        <p className="text-sm text-gray-600">Each table gets its own code. Scanning it opens the menu for that table, and guests can order straight from it. Orders arrive in the Orders tab marked with the table number.</p>
                        <div className="flex flex-wrap gap-3">
                            <a href={SITE_URL + '/qr'} target="_blank" rel="noopener" className="bg-victorian text-paper px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-victorianLight">Open the printable QR sheet ↗</a>
                            <a href={SITE_URL + '/menu?table=1'} target="_blank" rel="noopener" className="bg-white border border-gray-200 text-victorian px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-widest hover:border-brandBrown/40">Preview table 1 ↗</a>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    function OrdersPanel({ orders, loadError, info, showToast, confirmAction }) {
        const [showDone, setShowDone] = useState(false);
        const [, tick] = useState(0);
        useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30000); return () => clearInterval(t); }, []);

        const loyalty = loyaltyOf(info);
        const byTime = (a, b) => ((a.createdAt && a.createdAt.toMillis()) || 0) - ((b.createdAt && b.createdAt.toMillis()) || 0);
        const live = orders.filter(o => !DONE.includes(o.status)).sort(byTime);
        const done = orders.filter(o => DONE.includes(o.status)).sort(byTime).reverse();
        const takings = orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (Number(o.total) || 0), 0);

        const move = (o, status) =>
            db.collection('orders').doc(o.docId)
                .update({ status, handledBy: me(), updatedAt: FieldValue.serverTimestamp() })
                .catch(e => showToast(e.message, 'error'));

        const ready = (o) => {
            move(o, 'ready');
            if (o.type === 'takeaway' && o.phone) {
                window.open(waLink(o.phone, `Hello ${o.name || ''}! Your order ${o.code} from The Caffeine Ministry is ready to collect. See you at the counter!`), '_blank', 'noopener');
            }
        };

        const stamp = (o) => changeStamps(o.phone, { name: o.name, target: loyalty.stampsForReward, note: 'Order ' + o.code })
            .then(card => db.collection('orders').doc(o.docId).update({ stampAwarded: true, updatedAt: FieldValue.serverTimestamp() })
                .then(() => showToast(`Stamp added: ${card.stamps} of ${loyalty.stampsForReward}${card.stamps >= loyalty.stampsForReward ? ' — reward earned!' : ''}`, 'success')))
            .catch(e => showToast(e.message, 'error'));

        const btn = 'px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all';

        const card = (o) => {
            const st = ORDER_FLOW[o.status] || ORDER_FLOW.new;
            return (
                <div key={o.docId} className={`bg-white/95 p-5 rounded-2xl shadow-elegant border ${o.status === 'new' ? 'border-antique animate-alert-flash' : 'border-white/50'}`}>
                    <div className="flex justify-between items-start gap-3 mb-3">
                        <div>
                            <p className="font-mono text-2xl font-bold text-victorian tracking-widest leading-none">{o.code}</p>
                            <p className="text-sm font-bold text-brandBrown mt-1.5">{o.type === 'table' ? `Table ${o.table}` : `Pickup ${niceTime(o.pickupTime)}`}{o.name ? <span className="text-gray-500 font-normal"> · {o.name}</span> : null}</p>
                        </div>
                        <div className="text-right">
                            <span className={`text-[9px] uppercase font-bold tracking-widest px-2.5 py-1 rounded-lg border whitespace-nowrap ${st.cls}`}>{st.label}</span>
                            <p className="text-[10px] text-gray-400 mt-1.5">{ago(o.createdAt)}</p>
                        </div>
                    </div>
                    <ul className="text-sm space-y-1.5 mb-3 border-y border-gray-100 py-3">
                        {(o.lines || []).map((l, i) => (
                            <li key={i}>
                                <div className="flex justify-between gap-2"><span><b className="text-victorian">{l.qty} ×</b> {l.name}</span><span className="text-gray-400 tabular-nums">{rupees(l.price * l.qty)}</span></div>
                                {l.note && <p className="text-xs italic text-brandBrown pl-6">“{l.note}”</p>}
                            </li>
                        ))}
                    </ul>
                    {o.note && <p className="text-sm bg-paper/80 rounded-lg px-3 py-2 italic mb-3">“{o.note}”</p>}
                    <div className="flex justify-between items-center mb-4 text-sm">
                        {o.phone ? <a className="font-semibold text-brandBrown" href={`tel:+${o.phone}`}>+{o.phone}</a> : <span className="text-gray-400 text-xs">No phone given</span>}
                        <b className="text-victorian text-base">{rupees(o.total)}</b>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {o.status === 'new' && <button className={`${btn} bg-victorian text-paper border-victorian`} onClick={() => move(o, 'preparing')}>Start making</button>}
                        {o.status === 'preparing' && <button className={`${btn} bg-vintageGreen text-white border-vintageGreen`} onClick={() => ready(o)}>{o.type === 'takeaway' && o.phone ? 'Ready + WhatsApp' : 'Ready'}</button>}
                        {o.status === 'ready' && <button className={`${btn} bg-victorian text-paper border-victorian`} onClick={() => move(o, o.type === 'table' ? 'served' : 'collected')}>{o.type === 'table' ? 'Served' : 'Collected'}</button>}
                        {!DONE.includes(o.status) && <button className={`${btn} bg-white text-danger border-danger/30`} onClick={() => confirmAction(`Cancel order ${o.code}?`, () => move(o, 'cancelled'))}>Cancel</button>}
                        {loyalty.enabled && o.phone && o.status !== 'cancelled' && !o.stampAwarded &&
                            <button className={`${btn} bg-antiqueLight/60 text-victorian border-antique/40`} onClick={() => stamp(o)}>+1 loyalty stamp</button>}
                        {o.stampAwarded && <span className={`${btn} bg-white text-vintageGreen border-vintageGreen/30`}>Stamped ✓</span>}
                        {o.phone && <a className={`${btn} bg-white text-[#128C7E] border-[#25D366]/40`} href={waLink(o.phone)} target="_blank" rel="noopener">WhatsApp</a>}
                    </div>
                </div>
            );
        };

        return (
            <div className="space-y-5">
                {loadError && <div className="bg-dangerLight text-danger border border-danger/20 rounded-xl p-4 text-sm">{loadError}</div>}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <Metric title="New" value={orders.filter(o => o.status === 'new').length} subtitle="Waiting to start" icon={<Ico.Activity/>} borderColor={orders.some(o => o.status === 'new') ? 'border-antique' : 'border-gray-200'} />
                    <Metric title="In progress" value={orders.filter(o => ['preparing', 'ready'].includes(o.status)).length} subtitle="Being made or ready" icon={<Ico.Box/>} borderColor="border-brandBrown" />
                    <Metric title="Orders today" value={orders.filter(o => o.status !== 'cancelled').length} subtitle={`${orders.filter(o => o.type === 'takeaway' && o.status !== 'cancelled').length} takeaway`} icon={<Ico.FileText/>} borderColor="border-vintageGreen" />
                    <Metric title="Online takings" value={rupees(takings)} subtitle="Today, before payment" icon={<Ico.Users/>} borderColor="border-gray-200" />
                </div>
                {!live.length && <div className="bg-white/70 rounded-2xl p-10 text-center text-sm text-gray-500 border border-white/50">No open orders. Orders from table QR codes and the takeaway page appear here the moment they are sent. Turn the sound on to hear them arrive.</div>}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{live.map(card)}</div>
                {done.length > 0 && (
                    <div>
                        <button onClick={() => setShowDone(!showDone)} className="text-xs font-bold uppercase tracking-widest text-brandBrown">{showDone ? '−' : '+'} Finished today ({done.length})</button>
                        {showDone && <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4 opacity-90">{done.map(card)}</div>}
                    </div>
                )}
            </div>
        );
    }

    function StampsPanel({ info, showToast, confirmAction }) {
        const loyalty = loyaltyOf(info);
        const [phone, setPhone] = useState('');
        const [card, setCard] = useState(null);      // null = not looked up; false = no card yet
        const [name, setName] = useState('');
        const [busy, setBusy] = useState(false);
        const unsub = useRef(null);

        useEffect(() => () => unsub.current && unsub.current(), []);

        const lookUp = (e) => {
            if (e) e.preventDefault();
            const id = TCM.normalizePhone(phone);
            if (!/^[1-9][0-9]{7,14}$/.test(id)) return showToast('Enter a 10-digit mobile number', 'error');
            if (unsub.current) unsub.current();
            unsub.current = db.collection('loyalty').doc(id).onSnapshot(
                s => { setCard(s.exists ? s.data() : false); if (s.exists) setName(s.data().name || ''); },
                err => showToast(err.code === 'permission-denied' ? 'You do not have access to stamp cards.' : err.message, 'error'));
        };

        const act = (opts, msg) => {
            setBusy(true);
            changeStamps(phone, { name, target: loyalty.stampsForReward, ...opts })
                .then(c => showToast(msg(c), 'success'))
                .catch(e => showToast(e.message, 'error'))
                .then(() => setBusy(false));
        };

        const target = loyalty.stampsForReward;
        const stamps = card ? card.stamps : 0;
        const btn = 'px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest border transition-all disabled:opacity-40';

        return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white/90 backdrop-blur-xl p-6 rounded-2xl shadow-elegant border border-white/50 space-y-4">
                    <h3 className="font-serif text-xl text-victorian">Loyalty stamps</h3>
                    {!loyalty.enabled && <p className="text-sm bg-dangerLight text-danger rounded-lg p-3">The rewards programme is paused in Café details. Existing cards are kept.</p>}
                    <p className="text-sm text-gray-600">One stamp per visit. {target} stamps earn {loyalty.reward}. Ask for the guest's mobile number when they pay.</p>
                    <form onSubmit={lookUp} className="flex gap-2">
                        <input className="flex-1 px-4 py-3 rounded-xl border border-gray-200 bg-white text-lg tracking-wider" type="tel" inputMode="tel" placeholder="Mobile number" value={phone} onChange={e => { setPhone(e.target.value); setCard(null); }} />
                        <button className={`${btn} bg-victorian text-paper border-victorian`} type="submit">Find</button>
                    </form>
                    {card === false && <p className="text-sm text-gray-500">No card on this number yet. Add a name (optional) and give the first stamp to start one.</p>}
                    {card !== null && (
                        <input className="w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-white text-sm" placeholder="Guest's name (optional)" value={name} onChange={e => setName(e.target.value)} />
                    )}
                </div>
                {card !== null && (
                    <div className="bg-victorian text-paper p-6 rounded-2xl shadow-elegant space-y-5">
                        <div className="flex justify-between items-start">
                            <div><p className="font-serif text-2xl">{(card && card.name) || name || 'New card'}</p><p className="text-antiqueLight text-sm">+{TCM.normalizePhone(phone)}</p></div>
                            <div className="text-right"><p className="font-serif text-3xl text-antique">{stamps}<span className="text-lg text-paper/60"> / {target}</span></p></div>
                        </div>
                        <div className="grid grid-cols-5 gap-2 max-w-xs">
                            {Array.from({ length: target }).map((_, i) => (
                                <div key={i} className={`aspect-square rounded-full border-2 flex items-center justify-center text-sm ${i < Math.min(stamps, target) ? 'bg-antique border-antique text-victorian' : 'border-dashed border-antique/40 text-antique/60'}`}>{i < Math.min(stamps, target) ? '✓' : i === target - 1 ? '★' : ''}</div>
                            ))}
                        </div>
                        {stamps >= target && <p className="bg-antique text-victorian rounded-xl p-3 text-sm font-bold">Reward earned: {loyalty.reward}!</p>}
                        <div className="flex flex-wrap gap-2">
                            <button disabled={busy} className={`${btn} bg-antique text-victorian border-antique`} onClick={() => act({ delta: 1, note: 'Visit' }, c => `Stamped: ${c.stamps} of ${target}`)}>+1 stamp</button>
                            <button disabled={busy || stamps < target} className={`${btn} bg-white text-victorian border-white`} onClick={() => confirmAction(`Give ${loyalty.reward} and use ${target} stamps?`, () => act({ delta: 0, redeem: 1, note: 'Reward' }, () => 'Reward redeemed. Enjoy!'))}>Redeem reward</button>
                            <button disabled={busy || !stamps} className={`${btn} bg-transparent text-paper/70 border-paper/30`} onClick={() => confirmAction('Remove one stamp (a mistake)?', () => act({ delta: -1, note: 'Correction' }, c => `Removed. ${c.stamps} of ${target}`))}>Undo a stamp</button>
                        </div>
                        {card && (
                            <div className="text-xs text-paper/60 space-y-1 border-t border-white/10 pt-3">
                                <p>{card.lifetime || 0} visits stamped in total · {card.redeemed || 0} rewards enjoyed</p>
                                {(card.history || []).slice(0, 5).map((h, i) => (
                                    <p key={i}>{new Date(h.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {h.d > 0 ? '+' + h.d : h.d} · {h.note || ''} · {h.by}</p>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    function FeedbackPanel({ showToast }) {
        const [items, setItems] = useState([]);
        const [filter, setFilter] = useState('open');
        useEffect(() => db.collection('feedback').orderBy('createdAt', 'desc').limit(100).onSnapshot(
            s => setItems(s.docs.map(d => ({ docId: d.id, ...d.data() }))),
            e => showToast(e.code === 'permission-denied' ? 'Feedback is not readable yet. Deploy the updated firestore.rules.' : e.message, 'error')), []);

        const avg = items.length ? (items.reduce((s, f) => s + f.rating, 0) / items.length) : 0;
        const shown = items.filter(f => filter === 'all' ? true : filter === 'low' ? f.rating <= 3 : !f.resolved);
        const resolve = (f) => db.collection('feedback').doc(f.docId)
            .update({ resolved: !f.resolved, updatedAt: FieldValue.serverTimestamp() }).catch(e => showToast(e.message, 'error'));
        const note = (f) => {
            const t = window.prompt('Private note (what you did about it):', f.ownerNote || '');
            if (t === null) return;
            db.collection('feedback').doc(f.docId).update({ ownerNote: t.trim().slice(0, 300), updatedAt: FieldValue.serverTimestamp() })
                .catch(e => showToast(e.message, 'error'));
        };
        const btn = 'px-3 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all';
        const tagCounts = items.flatMap(f => f.tags || []).reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {});

        return (
            <div className="space-y-5">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <Metric title="Average rating" value={items.length ? avg.toFixed(1) + ' ★' : '–'} subtitle={`From ${items.length} replies`} icon={<Ico.Star/>} borderColor="border-antique" />
                    <Metric title="To look at" value={items.filter(f => !f.resolved).length} subtitle="Not yet marked done" icon={<Ico.Activity/>} borderColor="border-brandBrown" />
                    <Metric title="3 stars or fewer" value={items.filter(f => f.rating <= 3).length} subtitle="Worth a call" icon={<Ico.Users/>} borderColor="border-danger" />
                    <Metric title="Most praised" value={Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a])[0] || '–'} subtitle="Most-picked highlight" icon={<Ico.FileText/>} borderColor="border-vintageGreen" />
                </div>
                <div className="flex flex-wrap gap-2">
                    {[['open', 'To look at'], ['low', '3 stars or fewer'], ['all', 'All']].map(([id, label]) => (
                        <button key={id} onClick={() => setFilter(id)} className={`${btn} ${filter === id ? 'bg-brandBrown text-white border-brandBrown' : 'bg-white text-gray-600 border-gray-200'}`}>{label}</button>
                    ))}
                </div>
                {!shown.length && <div className="bg-white/70 rounded-2xl p-10 text-center text-sm text-gray-500 border border-white/50">Nothing here. Guests reach the feedback page from their order screen, the menu and the website footer.</div>}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {shown.map(f => (
                        <div key={f.docId} className={`bg-white/95 p-5 rounded-2xl shadow-elegant border ${f.rating <= 2 && !f.resolved ? 'border-danger/40' : 'border-white/50'} ${f.resolved ? 'opacity-70' : ''}`}>
                            <div className="flex justify-between items-start mb-2">
                                <p className="text-xl tracking-wider"><span className="text-antique">{'★'.repeat(f.rating)}</span><span className="text-gray-200">{'★'.repeat(5 - f.rating)}</span></p>
                                <p className="text-[10px] text-gray-400">{f.createdAt ? f.createdAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</p>
                            </div>
                            {(f.tags || []).length > 0 && <div className="flex flex-wrap gap-1 mb-2">{f.tags.map(t => <span key={t} className="text-[9px] uppercase font-bold tracking-widest bg-paper px-2 py-1 rounded">{t}</span>)}</div>}
                            {f.comment ? <p className="text-sm text-gray-800 whitespace-pre-wrap mb-3">{f.comment}</p> : <p className="text-sm text-gray-400 italic mb-3">No comment</p>}
                            <p className="text-xs text-gray-500 mb-3">{f.name || 'Anonymous'}{f.phone ? ' · +' + f.phone : ''}{f.visit ? ' · order ' + f.visit : ''}</p>
                            {f.ownerNote && <p className="text-xs bg-antiqueLight/40 rounded-lg px-3 py-2 mb-3">Note: {f.ownerNote}</p>}
                            <div className="flex flex-wrap gap-2">
                                <button className={`${btn} ${f.resolved ? 'bg-white text-gray-500 border-gray-200' : 'bg-vintageGreen text-white border-vintageGreen'}`} onClick={() => resolve(f)}>{f.resolved ? 'Reopen' : 'Mark done'}</button>
                                <button className={`${btn} bg-white text-victorian border-gray-200`} onClick={() => note(f)}>{f.ownerNote ? 'Edit note' : 'Add note'}</button>
                                {f.phone && <a className={`${btn} bg-white text-[#128C7E] border-[#25D366]/40`} href={waLink(f.phone, `Hello ${f.name || ''}, thank you for your feedback about The Caffeine Ministry.`)} target="_blank" rel="noopener">Reply on WhatsApp</a>}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    window.TCMGuest = { GuestDesk, changeStamps };
})();
