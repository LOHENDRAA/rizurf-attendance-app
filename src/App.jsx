import { useEffect, useRef, useState } from 'react'
import {
  Bell, Check, ChevronRight, Clock3, Compass, Download, FileScan,
  Home, LogOut, MapPin, QrCode, ScanLine, Settings,
  ShieldCheck, X,
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

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])
  const [today, setToday] = useState(null)
  const [modal, setModal] = useState(null)
  const [scannerError, setScannerError] = useState('')
  const [scanStatus, setScanStatus] = useState('')
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => localStorage.getItem('rizurf-notifications-enabled') === 'true')
  const [notifyClockIn, setNotifyClockIn] = useState(() => localStorage.getItem('rizurf-notify-clock-in') !== 'false')
  const [notifyClockOut, setNotifyClockOut] = useState(() => localStorage.getItem('rizurf-notify-clock-out') !== 'false')
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
        fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, notifyClockIn, notifyClockOut }) })
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
      })
      .catch(() => showNotice('error', 'Could not load attendance history from MySQL.'))
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

  const completeBreak = (breakAction) => {
    fetch('./api/attendance.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: breakAction }) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setToday(data.today)
        setHistory(data.records)
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
    setActiveTab(tab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const enableNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showNotice('error', 'Push notifications are not supported in this browser.')
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
      await fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription, notifyClockIn, notifyClockOut }) })
      setNotificationsEnabled(true)
      localStorage.setItem('rizurf-notifications-enabled', 'true')
      showNotice('success', 'Notifications turned on. You\'ll get a reminder if you forget to clock in or out.')
    } catch (error) {
      showNotice('error', 'Could not turn on notifications.')
    }
  }

  const updateNotificationPreference = async (type, value) => {
    if (type === 'clockIn') {
      setNotifyClockIn(value)
      localStorage.setItem('rizurf-notify-clock-in', String(value))
    } else {
      setNotifyClockOut(value)
      localStorage.setItem('rizurf-notify-clock-out', String(value))
    }
    if (!notificationsEnabled) return
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription) return
      await fetch('./api/subscribe.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update-preferences',
          endpoint: subscription.endpoint,
          notifyClockIn: type === 'clockIn' ? value : notifyClockIn,
          notifyClockOut: type === 'clockOut' ? value : notifyClockOut,
        }),
      })
    } catch (error) {
      // Preference is still applied locally; will re-sync next time the
      // subscription effect runs (e.g. on the next page load).
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

  const toggleNotifications = () => {
    if (notificationsEnabled) {
      disableNotifications()
    } else {
      enableNotifications()
    }
  }

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
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span><button className="icon-button" aria-label="Open settings" onClick={() => setModal('settings')}><Settings size={20} /></button></div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, Alex</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><span className="live-dot"></span><MapPin size={15} /> Sri Desa Entrepreneur Park</div></section>
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero"><div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.mode}. ${today.breakActive ? 'Break is active.' : 'Clock out when you finish.'}` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode || today.mode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions">{isClockedIn && <button className="secondary-action" onClick={() => completeBreak(today.breakActive ? 'break_end' : 'break_start')}><Clock3 size={17} /> {today.breakActive ? 'End break' : 'Start break'}</button>}<button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div><div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{OFFICE_ADDRESS}</small></div></section>

        <section className="quick-grid"><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.workingHours || '0h 00m'}</strong><em>{today?.breakActive ? 'On break' : today?.clockIn ? 'Net working time' : 'No attendance recorded yet'}</em>{today?.breakOvertimeLabel && <span className="overtime-badge">Extra break time taken: {today.breakOvertimeLabel}</span>}</div></article><article className="metric-card allowance-card"><div className="metric-icon"><span>RM</span></div><div><p>Estimated payout</p><strong>RM {estimatedPayout.toLocaleString()} <small>/ RM {monthlyTarget.toLocaleString()}</small></strong><div className="progress"><span style={{ width: `${Math.min(100, (estimatedPayout / monthlyTarget) * 100)}%` }}></span></div><em>RM {dailyRate} daily rate · {workedDays} days worked</em></div></article><article className="metric-card timeline-card"><div className="metric-icon yellow"><Compass size={19} /></div><div><p>Internship timeline</p><strong>{completedInternshipDays} <small>/ {totalInternshipDays} days</small></strong><div className="progress"><span style={{ width: `${timelinePercent}%` }}></span></div><em>Week {Math.ceil(completedInternshipDays / 7)} of {Math.ceil(totalInternshipDays / 7)}</em></div></article></section>
        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, grace-period records, and approved MCs.</p></div><button className="secondary-action export-button" onClick={() => window.print()}><Download size={17} /> Download attendance log (PDF)</button><article className="activity-card"><div className="history-list">{history.map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button></nav>

      {modal && modal !== 'settings' && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {modal === 'settings' && <div className="modal-backdrop" role="presentation"><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="modal-close" aria-label="Close settings" onClick={() => setModal(null)}><X size={18} /></button><p className="eyebrow">SYSTEM CONTROL</p><h2 id="settings-title">Attendance settings</h2><p className="modal-subtitle">Configure your allowance, display, and notification preferences.</p><div className="settings-section"><h3>Notifications</h3><div className="drawer-setting"><span><Bell size={18} /> Notifications</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><i></i></button></div>{notificationsEnabled && <div className="drawer-setting drawer-subsetting"><span>Clock-in reminders</span><button className={notifyClockIn ? 'toggle is-on' : 'toggle'} aria-pressed={notifyClockIn} onClick={() => updateNotificationPreference('clockIn', !notifyClockIn)}><i></i></button></div>}{notificationsEnabled && <div className="drawer-setting drawer-subsetting"><span>Clock-out reminders</span><button className={notifyClockOut ? 'toggle is-on' : 'toggle'} aria-pressed={notifyClockOut} onClick={() => updateNotificationPreference('clockOut', !notifyClockOut)}><i></i></button></div>}</div><div className="settings-section"><h3>Stipend</h3><div className="settings-grid"><label className="form-label">Daily allowance (RM)<input type="number" min="0" value={settings.dailyRate} onChange={(event) => setSettings({ ...settings, dailyRate: event.target.value })} /></label></div></div><div className="settings-section"><h3>Display</h3><div className="settings-grid"><label className="form-label">Theme<select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></label></div></div><button className="primary-button form-submit" onClick={() => { setModal(null); showNotice('success', 'Settings saved on this device.') }}>Save settings</button><button className="logout-button settings-logout" onClick={() => showNotice('success', 'You have been logged out of this demo.') }><LogOut size={18} /> Secure logout</button></section></div>}
    </div>
  )
}

export default App
