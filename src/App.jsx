import { useEffect, useRef, useState } from 'react'
import {
  Bell, Check, ChevronRight, Clock3, Download, FileScan,
  Home, LogOut, MapPin, QrCode, ScanLine, Settings,
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

function App() {
  const [employeeId, setEmployeeId] = useState(() => localStorage.getItem('rizurf-employee-id') || '')
  const [employeeName, setEmployeeName] = useState(() => localStorage.getItem('rizurf-employee-name') || '')
  const [employees, setEmployees] = useState([])
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
      return { theme: 'light', ...(JSON.parse(localStorage.getItem('rizurf-attendance-settings')) || {}) }
    } catch { return { theme: 'light' } }
  })
  const [deviceStatus, setDeviceStatus] = useState(null)
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
    if (!employeeId) return
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
        fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId, subscription, notifyClockIn, notifyClockOut }) })
      }
    }).catch(() => {})
  }, [employeeId])

  // Needed for the "who are you" picker, and for switching employees later
  // from Settings -- fetched regardless of whether someone's picked yet.
  useEffect(() => {
    fetch('./api/employees.php')
      .then((response) => response.json())
      .then((data) => { if (data.success) setEmployees(data.employees) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!employeeId) return
    fetch(`./api/attendance.php?employeeId=${encodeURIComponent(employeeId)}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setHistory(data.records)
        setToday(data.today)
      })
      .catch(() => showNotice('error', 'Could not load attendance history from MySQL.'))
  }, [employeeId])

  const selectEmployee = (employee) => {
    setEmployeeId(employee.id)
    setEmployeeName(employee.name)
    localStorage.setItem('rizurf-employee-id', employee.id)
    localStorage.setItem('rizurf-employee-name', employee.name)
  }

  const switchEmployee = () => {
    setEmployeeId('')
    setEmployeeName('')
    setToday(null)
    setHistory([])
    localStorage.removeItem('rizurf-employee-id')
    localStorage.removeItem('rizurf-employee-name')
  }

  const loadDeviceStatus = () => {
    fetch('./api/device.php')
      .then((response) => response.json())
      .then((data) => { if (data.success) setDeviceStatus(data) })
      .catch(() => {})
  }

  // Explicit "link this device" action -- same claim enforceDeviceOwnership()
  // already makes on every clock-in, just surfaced as its own step so it's
  // visible rather than something that silently happens the first time you
  // clock in.
  const linkDevice = () => {
    fetch('./api/device.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId }) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        showNotice('success', data.message)
        loadDeviceStatus()
      })
      .catch((error) => showNotice('error', error.message || 'Could not link this device.'))
  }

  const completeAttendance = (mode) => {
    const now = new Date()
    const time = formatTime(now)
    const payload = { employeeId, action, mode, qrToken: mode === 'Office' ? QR_PAYLOAD : null, latitude: window.lastAttendanceLatitude || null, longitude: window.lastAttendanceLongitude || null, accuracy: window.lastAttendanceAccuracy || null }
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
      await fetch('./api/subscribe.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId, subscription, notifyClockIn, notifyClockOut }) })
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

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (modal === 'scan') startScanner()
    return () => { stopScanner() }
  }, [modal])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  if (!employeeId) {
    return (
      <div className="app-shell">
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="who-are-you-title">
            <div className="modal-icon"><UserRound size={22} /></div>
            <p className="eyebrow">RIZURF ATTENDANCE</p>
            <h2 id="who-are-you-title">Who's clocking in?</h2>
            <p className="modal-subtitle">Pick your name to continue. This device will be remembered for you, so only you can clock in from it.</p>
            <div className="mode-options">
              {employees.length === 0 && <p className="modal-subtitle">Loading names...</p>}
              {employees.map((employee) => (
                <button key={employee.id} className="mode-option" onClick={() => selectEmployee(employee)}>
                  <span className="mode-icon office"><UserRound size={21} /></span>
                  <span><strong>{employee.name}</strong></span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="topbar-brand" href="#overview" aria-label="Rizurf Realty home"><img src={settings.theme === 'dark' ? './logo_dark.png' : './logo%20real.png'} alt="Rizurf Realty" /></a>
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span><button className="icon-button" aria-label="Open settings" onClick={() => { setModal('settings'); loadDeviceStatus() }}><Settings size={20} /></button></div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, {employeeName.split(' ')[0]}</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><span className="live-dot"></span><MapPin size={15} /> Sri Desa Entrepreneur Park</div></section>
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero"><div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.clockInMode}. Clock out when you finish.` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions"><button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div><div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{OFFICE_ADDRESS}</small></div></section>

        <section className="quick-grid"><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.workingHours || '0h 00m'}</strong><em>{today?.clockIn ? 'Net working time' : 'No attendance recorded yet'}</em></div></article></section>
        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, grace-period records, and approved MCs.</p></div><button className="secondary-action export-button" onClick={() => window.print()}><Download size={17} /> Download attendance log (PDF)</button><article className="activity-card"><div className="history-list">{history.map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button></nav>

      {modal && modal !== 'settings' && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {modal === 'settings' && <div className="modal-backdrop" role="presentation"><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><button className="modal-close" aria-label="Close settings" onClick={() => setModal(null)}><X size={18} /></button><p className="eyebrow">SYSTEM CONTROL</p><h2 id="settings-title">Attendance settings</h2><p className="modal-subtitle">Configure your display and notification preferences.</p><div className="settings-section"><h3>Identity</h3><div className="drawer-setting"><span><UserRound size={18} /> {employeeName}</span></div></div><div className="settings-section"><h3>My Device</h3>{!deviceStatus && <p className="modal-subtitle">Checking...</p>}{deviceStatus && deviceStatus.linked && deviceStatus.employeeId === employeeId && <div className="drawer-setting"><span><ShieldCheck size={18} /> Linked to you</span></div>}{deviceStatus && deviceStatus.linked && deviceStatus.employeeId !== employeeId && <p className="modal-subtitle">This device is linked to {deviceStatus.employeeName}. You can't clock in as {employeeName.split(' ')[0]} from it -- use a different device, or ask an admin to release it.</p>}{deviceStatus && !deviceStatus.linked && <><p className="modal-subtitle">This device isn't linked to anyone yet. Link it so only you can clock in from it -- got a new phone? Just link that one instead, whenever you're ready.</p><button className="secondary-action" onClick={linkDevice}>Link this device to my account</button></>}</div><div className="settings-section"><h3>Notifications</h3><div className="drawer-setting"><span><Bell size={18} /> Notifications</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><i></i></button></div>{notificationsEnabled && <div className="drawer-setting drawer-subsetting"><span>Clock-in reminders</span><button className={notifyClockIn ? 'toggle is-on' : 'toggle'} aria-pressed={notifyClockIn} onClick={() => updateNotificationPreference('clockIn', !notifyClockIn)}><i></i></button></div>}{notificationsEnabled && <div className="drawer-setting drawer-subsetting"><span>Clock-out reminders</span><button className={notifyClockOut ? 'toggle is-on' : 'toggle'} aria-pressed={notifyClockOut} onClick={() => updateNotificationPreference('clockOut', !notifyClockOut)}><i></i></button></div>}</div><div className="settings-section"><h3>Display</h3><div className="settings-grid"><label className="form-label">Theme<select value={settings.theme} onChange={(event) => setSettings({ ...settings, theme: event.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></label></div></div><button className="primary-button form-submit" onClick={() => { setModal(null); showNotice('success', 'Settings saved on this device.') }}>Save settings</button><button className="logout-button settings-logout" onClick={() => { setModal(null); switchEmployee() }}><LogOut size={18} /> Switch employee</button></section></div>}
    </div>
  )
}

export default App
