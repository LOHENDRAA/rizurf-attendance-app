import { useEffect, useRef, useState } from 'react'
import {
  Bell, CalendarDays, Check, ChevronRight, Clock3, Compass, Download, FileScan,
  FileText, Home, LogOut, MapPin, QrCode, ScanLine, Settings,
  ShieldCheck, UserRound, X,
} from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'
import './App.css'

const OFFICE_ADDRESS = 'First Floor, 28-1, Jln 1/116B, Sri Desa Entrepreneur Park'
const QR_PAYLOAD = 'Rizurf_Attandance'
// Public VAPID key -- safe to expose client-side by design, it's how the
// browser verifies push messages came from our server, not a secret.
const VAPID_PUBLIC_KEY = 'BPqEsi2uvS4b8E0yETemRtUOiKAMSgbE9SrmPFyS5EFDq1troDlH1Bf7gz44OCuIj7PCCRH-8qF1IaxXcLRPwCc'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit' })
}

function formatInternshipDate(date) {
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])
  const [today, setToday] = useState(null)
  const [lunchWindow, setLunchWindow] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [modal, setModal] = useState(null)
  const [scannerError, setScannerError] = useState('')
  const [scanStatus, setScanStatus] = useState('')
  const [leaveRequests, setLeaveRequests] = useState([])
  const [leaveForm, setLeaveForm] = useState({ leaveDate: '', category: 'Medical Leave/MC', reason: '', notes: '', attachmentName: '' })
  const [profileOpen, setProfileOpen] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem('rizurf-notifications-enabled') === 'true')
  const [notificationPrefs, setNotificationPrefs] = useState(() => {
    try {
      return { clockIn: true, clockOut: true, leaveStatus: true, ...(JSON.parse(localStorage.getItem('rizurf-notification-prefs')) || {}) }
    } catch { return { clockIn: true, clockOut: true, leaveStatus: true } }
  })
  // Guards the toggle while a permission prompt / subscribe call is in
  // flight, so a fast double-tap can't fire two overlapping enable/disable
  // attempts (which could otherwise leave the switch in a confusing state).
  const [notificationBusy, setNotificationBusy] = useState(false)
  const [settings, setSettings] = useState(() => {
    try {
      return { dailyRate: '50', theme: 'light', ...(JSON.parse(localStorage.getItem('rizurf-attendance-settings')) || {}) }
    } catch { return { dailyRate: '50', theme: 'light' } }
  })
  const locationRef = useRef(null)
  const scannerRef = useRef(null)
  const scanHandledRef = useRef(false)

  const isClockedIn = Boolean(today?.clockIn && !today?.clockOut)
  const action = isClockedIn ? 'out' : 'in'
  const showNotice = (type, message) => setNotice({ type, message })

  useEffect(() => {
    localStorage.setItem('rizurf-attendance-settings', JSON.stringify(settings))
    document.documentElement.dataset.theme = settings.theme
  }, [settings])

  useEffect(() => {
    localStorage.setItem('rizurf-notification-prefs', JSON.stringify(notificationPrefs))
  }, [notificationPrefs])

  // On load, if notifications were previously turned on and permission is
  // still granted, make sure a real push subscription still exists (the
  // browser can drop these on its own -- e.g. after clearing site data).
  useEffect(() => {
    const stored = localStorage.getItem('rizurf-notifications-enabled') === 'true'
    if (!stored || !('serviceWorker' in navigator) || !('Notification' in window)) return
    if (Notification.permission !== 'granted') {
      setNotificationsEnabled(false)
      localStorage.setItem('rizurf-notifications-enabled', 'false')
      return
    }
    navigator.serviceWorker.ready.then(async (registration) => {
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
        fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, preferences: notificationPrefs }) })
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    fetch('./api/attendance.php')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setHistory(data.records)
        setToday(data.today)
        setLunchWindow(data.lunchWindow)
      })
      .catch(() => showNotice('error', 'Could not load attendance history from MySQL.'))
  }, [])

  // Ticks the live shift/break timers shown on the Home tab.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const loadLeaveRequests = () => fetch('./api/leave.php')
      .then((response) => response.json())
      .then((data) => { if (data.success) setLeaveRequests(data.requests) })
      .catch(() => {})
    loadLeaveRequests()
    const refreshTimer = window.setInterval(loadLeaveRequests, 30000)
    return () => window.clearInterval(refreshTimer)
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
        setLunchWindow(data.lunchWindow)
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

  const completeBreak = (breakAction) => {
    fetch('./api/attendance.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: breakAction }) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setToday(data.today)
        setHistory(data.records)
        setLunchWindow(data.lunchWindow)
        showNotice('success', data.message)
      })
      .catch((error) => showNotice('error', error.message || 'Break could not be updated.'))
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

  const enableNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      // iOS Safari only exposes PushManager to a site added to the Home
      // Screen, not to an ordinary browser tab -- tell interns on iPhone
      // what to actually do instead of a generic "not supported" message.
      const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
      const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches
      showNotice('error', isIos && !isStandalone
        ? 'On iPhone, add this app to your Home Screen first (Share > Add to Home Screen), then turn notifications on from there.'
        : 'Push notifications are not supported in this browser.')
      return
    }
    // Once a browser denies permission, requestPermission() is not allowed to
    // prompt again -- it just silently resolves "denied". Catch that case
    // here so interns get a message that tells them how to actually fix it,
    // instead of the same generic failure every time they retry the toggle.
    if (Notification.permission === 'denied') {
      showNotice('error', 'Notifications are blocked for this site in your browser settings. Allow them there, then try again.')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        showNotice('error', 'Notification permission was not granted.')
        return
      }
      const registration = await navigator.serviceWorker.ready
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        })
      }
      await fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, preferences: notificationPrefs }) })
      setNotificationsEnabled(true)
      localStorage.setItem('rizurf-notifications-enabled', 'true')
      showNotice('success', 'Notifications turned on. You\'ll get a reminder if you forget to clock in or out.')
    } catch (error) {
      showNotice('error', 'Could not turn on notifications.')
    }
  }

  // Flips one reminder type on/off for the device that's already subscribed.
  // Doesn't touch the subscription itself -- just which reminders it wants.
  const updateNotificationPref = async (type, enabled) => {
    const nextPrefs = { ...notificationPrefs, [type]: enabled }
    setNotificationPrefs(nextPrefs)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return
      await fetch('./api/subscribe.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_preferences', endpoint: subscription.endpoint, preferences: nextPrefs }),
      })
    } catch (error) {
      showNotice('error', 'Could not save that preference. Try again.')
    }
  }

  const disableNotifications = async () => {
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', endpoint: subscription.endpoint }) })
        await subscription.unsubscribe()
      }
    } catch (error) {
      // Even if unsubscribing fails, still reflect "off" locally below.
    } finally {
      setNotificationsEnabled(false)
      localStorage.setItem('rizurf-notifications-enabled', 'false')
      showNotice('success', 'Notifications turned off.')
    }
  }

  const toggleNotifications = async () => {
    if (notificationBusy) return
    setNotificationBusy(true)
    try {
      if (notificationsEnabled) {
        await disableNotifications()
      } else {
        await enableNotifications()
      }
    } finally {
      setNotificationBusy(false)
    }
  }

  const submitLeave = (event) => {
    event.preventDefault()
    fetch('./api/leave.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaveForm) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setLeaveRequests((requests) => [{ ...leaveForm, id: `local-${Date.now()}`, status: 'Pending' }, ...requests])
        setLeaveForm({ leaveDate: '', category: 'Medical Leave/MC', reason: '', notes: '', attachmentName: '' })
        setModal(null)
        showNotice('success', data.message)
      })
      .catch((error) => showNotice('error', error.message || 'Could not submit request.'))
  }

  // MySQL DATETIME strings ("2026-09-10 09:03:00") aren't directly parseable
  // by Date() in every browser without the T separator.
  const parseServerDate = (value) => (value ? new Date(value.replace(' ', 'T')) : null)

  const formatDuration = (totalSeconds) => {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }

  const shiftStart = parseServerDate(today?.clockIn)
  const liveBreakSeconds = today?.breakActive && today?.breakStartedAt
    ? Math.max(0, Math.floor((now - parseServerDate(today.breakStartedAt)) / 1000))
    : 0
  const grossShiftSeconds = shiftStart
    ? Math.max(0, Math.floor(((parseServerDate(today.clockOut) || now) - shiftStart) / 1000))
    : 0
  const workingHoursLabel = shiftStart
    ? formatDuration(Math.max(0, grossShiftSeconds - (today.breakSeconds || 0) - liveBreakSeconds))
    : '0h 00m'
  const breakOvertimeLabel = today?.breakOvertimeSeconds > 0 ? formatDuration(today.breakOvertimeSeconds) : null

  // Lunch break can only be started inside this window (matches the server's
  // own check in attendance.php) -- ending an active break is never
  // time-restricted, so it isn't gated by this.
  const isWithinLunchWindow = (() => {
    if (!lunchWindow) return true
    const [startH, startM] = lunchWindow.start.split(':').map(Number)
    const [endH, endM] = lunchWindow.end.split(':').map(Number)
    const nowMinutes = now.getHours() * 60 + now.getMinutes()
    return nowMinutes >= startH * 60 + startM && nowMinutes <= endH * 60 + endM
  })()
  const canStartBreak = isClockedIn && !today?.breakActive && isWithinLunchWindow
  const canEndBreak = isClockedIn && today?.breakActive

  const workedDays = history.filter((entry) => entry.clockIn).length
  const dailyRate = Number(settings.dailyRate) || 50
  const monthlyTarget = 22 * dailyRate
  const estimatedPayout = workedDays * dailyRate
  const internshipStart = new Date('2026-08-03T00:00:00')
  const internshipEnd = new Date('2026-11-27T00:00:00')
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
        <a className="topbar-brand" href="#overview" aria-label="Rizurf Realty home"><img src={settings.theme === 'dark' ? './logo_dark.png' : './logo%20real.png'} alt="Rizurf Realty" /></a>
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span></div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        {activeTab === 'holidays' && <section className="tab-panel holidays-panel"><div className="tab-heading"><p className="eyebrow">TIME OFF</p><h1>Upcoming holidays</h1><p>Plan your internship days around public holidays and team off-days.</p></div><div className="holiday-list">{upcomingHolidays.map((holiday) => <article className="holiday-row" key={holiday.title}><span className="holiday-date"><CalendarDays size={18} /><strong>{holiday.date}</strong></span><span><strong>{holiday.title}</strong><small>{holiday.type}</small></span><ChevronRight size={17} /></article>)}</div><article className="allowance-panel"><div><p className="eyebrow">INTERNSHIP LEAVE</p><h2>Remaining allowance</h2><p>2 of 5 leave days remaining for your internship period.</p></div><strong>2 <small>/ 5 days</small></strong><div className="progress"><span style={{ width: '60%' }}></span></div></article></section>}
        {activeTab === 'profile' && <section className="tab-panel profile-preview"><div className="tab-heading"><p className="eyebrow">YOUR DETAILS</p><h1>Intern profile</h1><p>Credentials, leave requests, and app preferences.</p></div><button className="primary-button" onClick={() => setProfileOpen(true)}><UserRound size={18} /> Open profile</button><button className="secondary-action profile-leave-button" onClick={() => setModal('leave')}><FileText size={17} /> Submit MC / leave</button></section>}
        <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, Alex</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><span className="live-dot"></span><MapPin size={15} /> Sri Desa Entrepreneur Park</div></section>
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero"><div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.clockInMode}. ${today.breakActive ? 'Break is active.' : 'Clock out when you finish.'}` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions">{(canStartBreak || canEndBreak) && <button className="secondary-action" onClick={() => completeBreak(today.breakActive ? 'break_end' : 'break_start')}><Clock3 size={17} /> {today.breakActive ? 'End break' : 'Start break'}</button>}{isClockedIn && !canStartBreak && !canEndBreak && lunchWindow && <span className="location-note"><Clock3 size={14} /> Lunch break available {lunchWindow.start}–{lunchWindow.end}</span>}<button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button><button className="secondary-action" onClick={() => setModal('leave')}><FileText size={17} /> MC / Leave</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div><div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{OFFICE_ADDRESS}</small></div></section>

        <section className="quick-grid"><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{workingHoursLabel}</strong><em>{today?.breakActive ? 'On break' : today?.clockIn ? 'Net working time' : 'No attendance recorded yet'}</em>{breakOvertimeLabel && <span className="overtime-badge">Extra break time taken: {breakOvertimeLabel}</span>}</div></article><article className="metric-card allowance-card"><div className="metric-icon"><span>RM</span></div><div><p>Estimated payout</p><strong>RM {estimatedPayout.toLocaleString()} <small>/ RM {monthlyTarget.toLocaleString()}</small></strong><div className="progress"><span style={{ width: `${Math.min(100, (estimatedPayout / monthlyTarget) * 100)}%` }}></span></div><em>RM {dailyRate} daily rate · {workedDays} days worked</em></div></article><article className="metric-card timeline-card"><div className="metric-icon yellow"><Compass size={19} /></div><div><p>Internship timeline</p><strong>{completedInternshipDays} <small>/ {totalInternshipDays} days</small></strong><div className="progress"><span style={{ width: `${timelinePercent}%` }}></span></div><em>Week {Math.ceil(completedInternshipDays / 7)} of {Math.ceil(totalInternshipDays / 7)}</em></div></article></section>
        <section className="leave-status-card home-only"><div className="section-heading"><div><p className="eyebrow">REQUEST TRACKER</p><h2>Leave & MC Status</h2></div><button className="text-button" onClick={() => setModal('leave')}>New request <ChevronRight size={15} /></button></div>{leaveRequests.length === 0 ? <p className="empty-status">No leave or MC requests yet.</p> : <div className="request-status-list">{leaveRequests.slice(0, 4).map((request) => <div className="request-status-row" key={request.id}><div><strong>{request.leave_date || request.leaveDate}</strong><span>{request.category}{request.reason ? ` · ${request.reason}` : ''}</span></div><span className={`approval-badge ${(request.status || 'Pending').toLowerCase().replaceAll(' ', '-')}`}>{request.status === 'Pending' ? 'Pending Supervisor Approval' : request.status}</span></div>)}</div>}</section>

        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, grace-period records, and approved MCs.</p></div><button className="secondary-action export-button" onClick={() => window.print()}><Download size={17} /> Download attendance log (PDF)</button><article className="activity-card"><div className="history-list">{history.map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className={activeTab === 'holidays' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('holidays')}><CalendarDays size={21} /><span>Holidays</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button><button className={activeTab === 'profile' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('profile')}><span className="profile-nav-icon"><UserRound size={21} /><i></i></span><span>Profile</span></button></nav>

      {modal && modal !== 'leave' && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {modal === 'leave' && <div className="modal-backdrop" role="presentation"><form className="modal leave-modal" onSubmit={submitLeave}><button type="button" className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button><div className="modal-icon"><FileText size={22} /></div><p className="eyebrow">REQUEST TIME OFF</p><h2 id="leave-title">MC & leave submission</h2><p className="modal-subtitle">Submit a request for your supervisor to review.</p><label className="form-label">Date<input required type="date" value={leaveForm.leaveDate} onChange={(event) => setLeaveForm({ ...leaveForm, leaveDate: event.target.value })} /></label><label className="form-label">Category<select value={leaveForm.category} onChange={(event) => setLeaveForm({ ...leaveForm, category: event.target.value, reason: event.target.value === 'Other' ? leaveForm.reason : '' })}><option>Medical Leave/MC</option><option>Emergency Leave</option><option>University Event</option><option>Other</option></select></label>{leaveForm.category === 'Other' && <label className="form-label">Please specify reason<input required type="text" value={leaveForm.reason} onChange={(event) => setLeaveForm({ ...leaveForm, reason: event.target.value })} placeholder="Please specify reason" /></label>}<label className="form-label">Slip or supporting file<input type="file" accept="image/*,.pdf" onChange={(event) => setLeaveForm({ ...leaveForm, attachmentName: event.target.files?.[0]?.name || '' })} /></label><label className="form-label">Notes<textarea rows="3" value={leaveForm.notes} onChange={(event) => setLeaveForm({ ...leaveForm, notes: event.target.value })} placeholder="Optional note for your supervisor" /></label><button className="primary-button form-submit" type="submit">Submit for approval</button><div className="request-statuses"><strong>Approval status</strong>{leaveRequests.slice(0, 3).map((request) => <span key={request.id}><b className={`status-dot ${request.status.toLowerCase()}`}></b>{request.leave_date || request.leaveDate} · {request.category}{request.reason ? ` · ${request.reason}` : ''} · {request.status}</span>)}</div></form></div>}
      {profileOpen && <div className="profile-backdrop" onClick={(event) => event.target === event.currentTarget && setProfileOpen(false)}><aside className="profile-drawer"><button className="drawer-close" aria-label="Close profile" onClick={() => setProfileOpen(false)}><X size={19} /></button><div className="drawer-avatar">AM</div><p className="eyebrow">INTERN PROFILE</p><h2>Alex Morgan</h2><div className="credential-list"><div><span>Full legal name</span><strong>Alex Morgan</strong></div><div><span>Role / title</span><strong>Marketing & Community Manager Intern</strong></div><div><span>Company</span><strong>Rizurf Realty</strong></div><div><span>Internship duration</span><strong>{formatInternshipDate(internshipStart)} – {formatInternshipDate(internshipEnd)}</strong></div></div><div className="drawer-setting"><span><Bell size={18} /> Notifications</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} disabled={notificationBusy} onClick={toggleNotifications}><i></i></button></div>{notificationsEnabled && <div className="drawer-subsettings"><div className="drawer-subsetting"><span>Clock-in reminders</span><button className={notificationPrefs.clockIn ? 'toggle toggle-sm is-on' : 'toggle toggle-sm'} aria-pressed={notificationPrefs.clockIn} onClick={() => updateNotificationPref('clockIn', !notificationPrefs.clockIn)}><i></i></button></div><div className="drawer-subsetting"><span>Clock-out reminders</span><button className={notificationPrefs.clockOut ? 'toggle toggle-sm is-on' : 'toggle toggle-sm'} aria-pressed={notificationPrefs.clockOut} onClick={() => updateNotificationPref('clockOut', !notificationPrefs.clockOut)}><i></i></button></div><div className="drawer-subsetting"><span>Leave approval updates</span><button className={notificationPrefs.leaveStatus ? 'toggle toggle-sm is-on' : 'toggle toggle-sm'} aria-pressed={notificationPrefs.leaveStatus} onClick={() => updateNotificationPref('leaveStatus', !notificationPrefs.leaveStatus)}><i></i></button></div></div>}<button className="drawer-setting drawer-action" onClick={() => { setProfileOpen(false); setModal('settings') }}><Settings size={18} /> Account settings</button><button className="logout-button" onClick={() => showNotice('success', 'You have been logged out of this demo.') }><LogOut size={18} /> Log out</button></aside></div>}
      {modal === 'settings' && <div className="modal-backdrop" role="presentation"><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="modal-close" aria-label="Close settings" onClick={() => setModal(null)}><X size={18} /></button><p className="eyebrow">SYSTEM CONTROL</p><h2 id="settings-title">Attendance settings</h2><p className="modal-subtitle">Configure intern schedules, allowances, location rules, alerts, and display preferences.</p><div className="settings-section"><h3>Stipend</h3><div className="settings-grid"><label className="form-label">Daily allowance (RM)<input type="number" min="0" value={settings.dailyRate} onChange={(event) => setSettings({ ...settings, dailyRate: event.target.value })} /></label></div></div><div className="settings-section"><h3>Display</h3><div className="settings-grid"><label className="form-label">Theme<select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></label></div></div><button className="primary-button form-submit" onClick={() => { setModal(null); showNotice('success', 'Settings saved on this device.') }}>Save settings</button><button className="logout-button settings-logout" onClick={() => showNotice('success', 'You have been logged out of this demo.') }><LogOut size={18} /> Secure logout</button></section></div>}
    </div>
  )
}

export default App
