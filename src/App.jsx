import { useEffect, useRef, useState } from 'react'
import {
  Bell, CalendarDays, Check, ChevronRight, Clock3, Compass, Download, FileScan,
  FileText, Home, MapPin, QrCode, ScanLine, Settings,
  ShieldCheck, UserRound, X,
} from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'
import './App.css'

const OFFICE_ADDRESS_FALLBACK = 'First Floor, 28-1, Jln 1/116B, Sri Desa Entrepreneur Park'
const QR_PAYLOAD = 'Rizurf_Attandance'

function initialsOf(name) {
  return (name || '').trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || 'RZ'
}

function formatDay(value) {
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit' })
}

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])
  const [today, setToday] = useState(null)
  const [modal, setModal] = useState(null)
  const [scannerError, setScannerError] = useState('')
  const [scanStatus, setScanStatus] = useState('')
  const [leaveRequests, setLeaveRequests] = useState([])
  const [leaveForm, setLeaveForm] = useState({ leaveDate: '', category: 'Medical Leave/MC', notes: '', attachmentName: '' })
  const [profileOpen, setProfileOpen] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [me, setMe] = useState(null)
  const locationRef = useRef(null)
  const scannerRef = useRef(null)
  const scanHandledRef = useRef(false)

  const isClockedIn = Boolean(today?.clockIn && !today?.clockOut)
  const action = isClockedIn ? 'out' : 'in'
  const showNotice = (type, message) => setNotice({ type, message })

  useEffect(() => {
    fetch('./api/me.php')
      .then((response) => response.json())
      .then((data) => { if (!data.error) setMe(data) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('./api/attendance.php')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message || data.error?.message || 'Could not load your attendance.')
        setHistory(data.records || [])
        setToday(data.today || null)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load your attendance history.'))
  }, [])

  useEffect(() => {
    fetch('./api/leave.php')
      .then((response) => response.json())
      .then((data) => { if (data.success) setLeaveRequests(data.requests || []) })
      .catch(() => {})
  }, [])

  const completeAttendance = (mode) => {
    const now = new Date()
    const time = formatTime(now)
    const payload = { action, mode, qrToken: mode === 'Office' ? QR_PAYLOAD : null, latitude: window.lastAttendanceLatitude || null, longitude: window.lastAttendanceLongitude || null, accuracy: window.lastAttendanceAccuracy || null }
    fetch('./api/attendance.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setToday(data.today)
        setHistory(data.records)
        showNotice('success', `${action === 'in' ? 'Clocked in' : 'Clocked out'} at ${time} via ${mode}. ${data.message}`)
        setModal(null)
        setScannerError('')
        setScanStatus('')
        window.history.replaceState(null, '', `${window.location.pathname}#overview`)
        window.scrollTo({ top: 0, behavior: 'smooth' })
      })
      .catch((error) => {
        setScanStatus('')
        if (mode === 'Office') {
          setScannerError(error.message || 'Attendance could not be saved.')
        } else {
          showNotice('error', error.message || 'Attendance could not be saved.')
        }
      })
  }

  const chooseMode = (mode) => {
    if (mode === 'Hybrid') {
      completeAttendance('Hybrid')
      return
    }
    setScannerError('')
    setScanStatus('')
    scanHandledRef.current = false
    locationRef.current = getCurrentLocation()
    setModal('scan')
  }

  const getCurrentLocation = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location services are not available in this browser.'))
      return
    }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve(coords), (error) => {
      reject(new Error(error.code === 1
        ? 'Location permission was blocked. Allow location access for this site and scan again.'
        : 'Location took too long. Turn on phone location services and try again, or choose Hybrid.'))
    }, { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 })
  })

  const verifyOfficeLocation = () => {
    setScannerError('')
    setScanStatus('QR accepted. Saving attendance...')
    const locationPromise = locationRef.current || getCurrentLocation()
    locationPromise.then((coords) => {
      window.lastAttendanceLatitude = coords.latitude
      window.lastAttendanceLongitude = coords.longitude
      window.lastAttendanceAccuracy = coords.accuracy
      completeAttendance('Office')
    }).catch((error) => {
      setScanStatus('')
      setScannerError(error.message)
    })
  }

  const stopScanner = async () => {
    const scanner = scannerRef.current
    scannerRef.current = null
    if (!scanner) return
    try { await scanner.stop() } catch { /* scanner may already be stopped */ }
    try { scanner.clear() } catch { /* camera element may already be cleared */ }
  }

  const startScanner = async () => {
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
      setScannerError('Camera scanning requires HTTPS on a phone. Use the QR image upload below or choose Hybrid.')
      return
    }
    const scanner = new Html5Qrcode('qr-reader')
    scannerRef.current = scanner
    try {
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 220 } }, (decodedText) => {
        if (scanHandledRef.current) return
        if (decodedText.trim() !== QR_PAYLOAD) {
          setScannerError(`QR read as “${decodedText.trim()}”, but the expected value is “${QR_PAYLOAD}”.`)
          return
        }
        scanHandledRef.current = true
        stopScanner()
        verifyOfficeLocation()
      }, () => {})
    } catch {
      setScannerError('Camera access was blocked. Allow camera permission for this site, or use the QR image upload below.')
    }
  }

  const scanQrImage = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const scanner = new Html5Qrcode('qr-reader')
    scannerRef.current = scanner
    setScanStatus('Reading QR image...')
    try {
      const decodedText = await scanner.scanFile(file, true)
      await stopScanner()
      if (decodedText.trim() !== QR_PAYLOAD) {
        setScanStatus('')
        setScannerError(`QR read as “${decodedText.trim()}”, but the expected value is “${QR_PAYLOAD}”.`)
        return
      }
      verifyOfficeLocation()
    } catch {
      setScanStatus('')
      setScannerError('Could not read a QR code from that image.')
    }
    event.target.value = ''
  }

  const openAttendance = () => {
    setModal('mode')
    setScannerError('')
  }

  const openScanner = () => {
    setActiveTab('home')
    setScannerError('')
    setScanStatus('')
    scanHandledRef.current = false
    locationRef.current = getCurrentLocation()
    setModal('scan')
  }

  const selectTab = (tab) => {
    if (tab === 'scan') {
      openScanner()
      return
    }
    if (tab === 'profile') {
      setActiveTab('profile')
      setProfileOpen(true)
      return
    }
    setActiveTab(tab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const upcomingHolidays = [
    { date: '16 Sep', title: 'Malaysia Day', type: 'Public holiday' },
    { date: '31 Aug', title: 'Merdeka Day', type: 'Public holiday' },
    { date: 'Company', title: 'Rizurf team off-day', type: 'Company off-day' },
  ]

  const submitLeave = (event) => {
    event.preventDefault()
    fetch('./api/leave.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaveForm) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setLeaveRequests((requests) => [{ ...leaveForm, id: `local-${Date.now()}`, status: 'Pending' }, ...requests])
        setLeaveForm({ leaveDate: '', category: 'Medical Leave/MC', notes: '', attachmentName: '' })
        setModal(null)
        showNotice('success', data.message)
      })
      .catch((error) => showNotice('error', error.message || 'Could not submit request.'))
  }

  const intern = me?.intern || null
  const notLinked = Boolean(me && me.linked === false)
  const displayName = intern ? `${intern.first_name} ${intern.last_name}` : (me?.name || 'Intern')
  const firstName = (intern?.first_name || me?.name || 'there').split(' ')[0]
  const initials = intern ? initialsOf(`${intern.first_name} ${intern.last_name}`) : initialsOf(me?.name)
  const officeAddress = me?.office?.address || OFFICE_ADDRESS_FALLBACK

  const workedDays = history.filter((entry) => entry.clockIn).length
  const dailyRate = 50
  const monthlyTarget = 22 * dailyRate
  const estimatedPayout = workedDays * dailyRate
  const internshipStart = new Date(`${intern?.internship_start_date || '2026-08-03'}T00:00:00`)
  const internshipEnd = new Date(`${intern?.internship_end_date || '2026-11-27'}T00:00:00`)
  const totalInternshipDays = Math.max(1, Math.ceil((internshipEnd - internshipStart) / 86400000))
  const completedInternshipDays = Math.min(totalInternshipDays, Math.max(0, Math.ceil((new Date() - internshipStart) / 86400000)))
  const timelinePercent = Math.round((completedInternshipDays / totalInternshipDays) * 100)

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (modal === 'scan') startScanner()
    return () => { stopScanner() }
  }, [modal])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="breadcrumbs"><span>Attendance console</span><b>/</b><strong>Dashboard</strong></div>
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span><button className="icon-button" aria-label="Notifications"><Bell size={18} /></button><button className="profile-chip" aria-label="Open profile" onClick={() => selectTab('profile')}><span className="avatar">{initials}</span><span className="profile-name">{displayName}</span><ChevronRight size={15} /></button></div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        {activeTab === 'holidays' && <section className="tab-panel holidays-panel"><div className="tab-heading"><p className="eyebrow">TIME OFF</p><h1>Upcoming holidays</h1><p>Plan your internship days around public holidays and team off-days.</p></div><div className="holiday-list">{upcomingHolidays.map((holiday) => <article className="holiday-row" key={holiday.title}><span className="holiday-date"><CalendarDays size={18} /><strong>{holiday.date}</strong></span><span><strong>{holiday.title}</strong><small>{holiday.type}</small></span><ChevronRight size={17} /></article>)}</div><article className="allowance-panel"><div><p className="eyebrow">INTERNSHIP LEAVE</p><h2>Remaining allowance</h2><p>2 of 5 leave days remaining for your internship period.</p></div><strong>2 <small>/ 5 days</small></strong><div className="progress"><span style={{ width: '60%' }}></span></div></article></section>}
        {activeTab === 'profile' && <section className="tab-panel profile-preview"><div className="tab-heading"><p className="eyebrow">YOUR DETAILS</p><h1>Intern profile</h1><p>Credentials, leave requests, and app preferences.</p></div><button className="primary-button" onClick={() => setProfileOpen(true)}><UserRound size={18} /> Open profile</button><button className="secondary-action profile-leave-button" onClick={() => setModal('leave')}><FileText size={17} /> Submit MC / leave</button></section>}
        <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, {firstName}</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><span className="live-dot"></span><MapPin size={15} /> {intern?.department_id ? `Dept ${intern.department_id}` : 'Rizurf'}</div></section>
        {notLinked && <div className="notice error" role="status"><X size={17} />{me.reason === 'lookup_failed'
          ? `Could not reach the Intern Database${me.detail ? ` (${me.detail})` : ''}. Your attendance will load once it is back.`
          : `Your Rizurf account${me?.email ? ` (${me.email})` : ''} isn't linked to an intern record yet. Ask an admin to add you in the Intern Database.`}</div>}
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero"><div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.mode}. Clock out when you finish.` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode || today.mode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions"><button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button><button className="secondary-action" onClick={() => setModal('leave')}><FileText size={17} /> MC / Leave</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div><div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{officeAddress}</small></div></section>

        <section className="quick-grid"><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.clockIn || '—'} <small>{today?.clockOut ? `to ${today.clockOut}` : '/ pending'}</small></strong><em>{today?.mode || 'No attendance recorded yet'}</em></div></article><article className="metric-card allowance-card"><div className="metric-icon"><span>RM</span></div><div><p>Estimated payout</p><strong>RM {estimatedPayout.toLocaleString()} <small>/ RM {monthlyTarget.toLocaleString()}</small></strong><div className="progress"><span style={{ width: `${Math.min(100, (estimatedPayout / monthlyTarget) * 100)}%` }}></span></div><em>RM {dailyRate} daily rate · {workedDays} days worked</em></div></article><article className="metric-card timeline-card"><div className="metric-icon yellow"><Compass size={19} /></div><div><p>Internship timeline</p><strong>{completedInternshipDays} <small>/ {totalInternshipDays} days</small></strong><div className="progress"><span style={{ width: `${timelinePercent}%` }}></span></div><em>Week {Math.ceil(completedInternshipDays / 7)} of {Math.ceil(totalInternshipDays / 7)}</em></div></article></section>

        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, grace-period records, and approved MCs.</p></div><button className="secondary-action export-button" onClick={() => window.print()}><Download size={17} /> Download attendance log (PDF)</button><article className="activity-card"><div className="history-list">{history.map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className={activeTab === 'holidays' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('holidays')}><CalendarDays size={21} /><span>Holidays</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button><button className={activeTab === 'profile' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('profile')}><span className="profile-nav-icon"><UserRound size={21} /><i></i></span><span>Profile</span></button></nav>

      {modal && modal !== 'leave' && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {modal === 'leave' && <div className="modal-backdrop" role="presentation"><form className="modal leave-modal" onSubmit={submitLeave}><button type="button" className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button><div className="modal-icon"><FileText size={22} /></div><p className="eyebrow">REQUEST TIME OFF</p><h2 id="leave-title">MC & leave submission</h2><p className="modal-subtitle">Submit a request for your supervisor to review.</p><label className="form-label">Date<input required type="date" value={leaveForm.leaveDate} onChange={(event) => setLeaveForm({ ...leaveForm, leaveDate: event.target.value })} /></label><label className="form-label">Category<select value={leaveForm.category} onChange={(event) => setLeaveForm({ ...leaveForm, category: event.target.value })}><option>Medical Leave/MC</option><option>Emergency Leave</option><option>University Event</option></select></label><label className="form-label">Slip or supporting file<input type="file" accept="image/*,.pdf" onChange={(event) => setLeaveForm({ ...leaveForm, attachmentName: event.target.files?.[0]?.name || '' })} /></label><label className="form-label">Notes<textarea rows="3" value={leaveForm.notes} onChange={(event) => setLeaveForm({ ...leaveForm, notes: event.target.value })} placeholder="Optional note for your supervisor" /></label><button className="primary-button form-submit" type="submit">Submit for approval</button><div className="request-statuses"><strong>Approval status</strong>{leaveRequests.slice(0, 3).map((request) => <span key={request.id}><b className={`status-dot ${request.status.toLowerCase()}`}></b>{request.leave_date || request.leaveDate} · {request.category} · {request.status}</span>)}</div></form></div>}
      {profileOpen && <div className="profile-backdrop" onClick={(event) => event.target === event.currentTarget && setProfileOpen(false)}><aside className="profile-drawer"><button className="drawer-close" aria-label="Close profile" onClick={() => setProfileOpen(false)}><X size={19} /></button><div className="drawer-avatar">{initials}</div><p className="eyebrow">INTERN PROFILE</p><h2>{displayName}</h2><div className="credential-list"><div><span>Full legal name</span><strong>{displayName}</strong></div><div><span>Reference</span><strong>{intern?.ref_number || '—'}</strong></div><div><span>Rizurf account</span><strong>{me?.email || '—'}</strong></div><div><span>Arrangement</span><strong>{intern ? `${intern.mode} · ${intern.allowance}` : '—'}</strong></div><div><span>Internship duration</span><strong>{intern ? `${formatDay(intern.internship_start_date)} – ${formatDay(intern.internship_end_date)}` : '—'}</strong></div></div><div className="drawer-setting"><span><Bell size={18} /> Notifications</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={() => setNotificationsEnabled(!notificationsEnabled)}><i></i></button></div><button className="drawer-setting drawer-action"><Settings size={18} /> Account settings</button><p className="drawer-note">Signed in through the Rizurf gateway. Sign out there.</p></aside></div>}
    </div>
  )
}

export default App
