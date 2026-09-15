import { useEffect, useRef, useState } from 'react'
import {
  Bell, Check, ChevronRight, Clock3, FileScan,
  Home, LogOut, MapPin, Moon, QrCode, ScanLine, Settings,
  ShieldCheck, Sun, X,
} from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'
import './App.css'

const OFFICE_ADDRESS_FALLBACK = 'First Floor, 28-1, Jln 1/116B, Sri Desa Entrepreneur Park'
const QR_PAYLOAD = 'Rizurf_Attandance'
// Public VAPID key -- safe to expose client-side by design, it's how the
// browser verifies a push came from our server, not a secret. Paired with
// VAPID_PRIVATE_KEY server-side; regenerate both together or subscriptions
// silently stop working.
const VAPID_PUBLIC_KEY = 'BEmUTTBYoJ6HqcdHvtqY_Nlxw6E22xYQfBrB48anQ8lCMVhQSMMBM6SNEu1HVO32bW9VtV4sAZ7bFHagcZrTMak'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

function initialsOf(name) {
  return (name || '').trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || 'RZ'
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(date) {
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit' })
}

function SkeletonLine({ width, height = 14, style }) {
  return <span className="skeleton skeleton-line" style={{ width, height, ...style }}></span>
}

function ProfileChipSkeleton() {
  return <span className="profile-chip"><span className="skeleton skeleton-circle avatar"></span><SkeletonLine width={72} height={11} style={{ marginLeft: 4 }} /></span>
}

function WelcomeRowSkeleton() {
  return <section className="welcome-row"><div><SkeletonLine width={90} height={11} style={{ marginBottom: 12 }} /><SkeletonLine width={230} height={30} style={{ marginBottom: 10 }} /><SkeletonLine width={200} height={14} /></div><span className="skeleton skeleton-pill" style={{ width: 150, height: 34 }}></span></section>
}

function HeroSkeleton() {
  return <div className="hero-copy"><SkeletonLine width={110} height={10} style={{ marginBottom: 14 }} /><SkeletonLine width={220} height={26} style={{ marginBottom: 12 }} /><SkeletonLine width={260} height={13} style={{ marginBottom: 22 }} /><span className="skeleton skeleton-pill" style={{ width: 140, height: 42 }}></span></div>
}

function MetricCardSkeleton() {
  return <article className="metric-card"><span className="skeleton skeleton-circle" style={{ width: 36, height: 36 }}></span><div><SkeletonLine width={70} height={11} style={{ marginBottom: 8 }} /><SkeletonLine width={50} height={20} /></div></article>
}

function HistoryRowSkeleton() {
  return <div className="history-row"><div className="history-date"><SkeletonLine width={40} height={11} style={{ marginBottom: 4 }} /><SkeletonLine width={55} height={10} /></div><div className="history-times"><SkeletonLine width={60} height={11} style={{ marginBottom: 4 }} /><SkeletonLine width={70} height={10} /></div><SkeletonLine width={45} height={10} /><span className="skeleton skeleton-pill" style={{ width: 50, height: 20 }}></span></div>
}

function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [notice, setNotice] = useState(null)
  const [history, setHistory] = useState([])
  const [today, setToday] = useState(null)
  const [modal, setModal] = useState(null)
  const [scannerError, setScannerError] = useState('')
  const [scanStatus, setScanStatus] = useState('')
  const [profileOpen, setProfileOpen] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [me, setMe] = useState(null)
  const [meLoaded, setMeLoaded] = useState(false)
  const [attendanceLoaded, setAttendanceLoaded] = useState(false)
  const [device, setDevice] = useState(null)
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('rizurf-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
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
      .finally(() => setMeLoaded(true))
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
      .finally(() => setAttendanceLoaded(true))
  }, [])

  const showSkeleton = !meLoaded || !attendanceLoaded

  const loadDeviceStatus = () => fetch('./api/device.php')
    .then((response) => response.json())
    .then((data) => { if (data.success) setDevice(data) })
    .catch(() => {})

  useEffect(() => { loadDeviceStatus() }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('rizurf-theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  // On load, reflect whatever this browser actually has -- not a guess --
  // since a subscription can be dropped by the browser itself (e.g. site
  // data cleared) without the app ever being told.
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setNotificationsEnabled(Boolean(subscription)))
      .catch(() => {})
  }, [])

  const enableNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      showNotice('error', 'Notifications are not supported in this browser.')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        showNotice('error', 'Notification permission was blocked. Allow it for this site to turn reminders on.')
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
      const response = await fetch('./api/subscribe.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.message)
      setNotificationsEnabled(true)
      showNotice('success', 'Clock in/out reminders are on.')
    } catch (error) {
      showNotice('error', error.message || 'Could not turn on notifications.')
    }
  }

  const disableNotifications = async () => {
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await fetch('./api/subscribe.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', endpoint: subscription.endpoint }),
        })
        await subscription.unsubscribe()
      }
      setNotificationsEnabled(false)
      showNotice('success', 'Clock in/out reminders are off.')
    } catch {
      showNotice('error', 'Could not turn off notifications.')
    }
  }

  const toggleNotifications = () => (notificationsEnabled ? disableNotifications() : enableNotifications())

  // Releases the device from your account, e.g. after a hardware change --
  // not a way to bump someone else off their own device (the server only
  // lets you release a device that's actually linked to you).
  const releaseDevice = () => {
    fetch('./api/device.php', { method: 'POST' })
      .then((response) => response.json())
      .then((data) => {
        setDevice(data)
        showNotice('success', 'This device has been unlinked. It will link to whoever clocks in next.')
      })
      .catch(() => showNotice('error', 'Could not unlink this device.'))
  }

  // Ends this app's own session, then sends the browser straight to the
  // gateway itself (not back through our own '/', which a live gateway SSO
  // session could otherwise use to silently sign you straight back in here).
  const signOut = () => {
    fetch('./api/signout.php', { method: 'POST' })
      .then((response) => response.json())
      .then((data) => { window.location.href = data.gatewayUrl || './' })
      .catch(() => { window.location.href = './' })
  }

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
        loadDeviceStatus()
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
      setProfileOpen(true)
      return
    }
    setActiveTab(tab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const intern = me?.intern || null
  const notLinked = Boolean(me && me.linked === false)
  const displayName = intern ? `${intern.first_name} ${intern.last_name}` : (me?.name || 'Intern')
  const firstName = (intern?.first_name || me?.name || 'there').split(' ')[0]
  const initials = intern ? initialsOf(`${intern.first_name} ${intern.last_name}`) : initialsOf(me?.name)
  const officeAddress = me?.office?.address || OFFICE_ADDRESS_FALLBACK

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
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span>{meLoaded ? <button className="profile-chip" aria-label="Open profile" onClick={() => selectTab('profile')}><span className="avatar">{initials}</span><span className="profile-name">{displayName}</span><ChevronRight size={15} /></button> : <ProfileChipSkeleton />}</div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        {showSkeleton ? <WelcomeRowSkeleton /> : <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, {firstName}</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><span className="live-dot"></span><MapPin size={15} /> {intern?.department_name || 'Rizurf'}</div></section>}
        {notLinked && <div className="notice error" role="status"><X size={17} />{me.reason === 'lookup_failed'
          ? `Could not reach the Intern Database${me.detail ? ` (${me.detail})` : ''}. Your attendance will load once it is back.`
          : `Your Rizurf account${me?.email ? ` (${me.email})` : ''} isn't linked to an intern record yet. Ask an admin to add you in the Intern Database.`}</div>}
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero">{showSkeleton ? <HeroSkeleton /> : <div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.mode}. Clock out when you finish.` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode || today.mode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions"><button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div>}<div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{officeAddress}</small></div></section>

        <section className="quick-grid">{showSkeleton ? <><MetricCardSkeleton /><MetricCardSkeleton /></> : <><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.clockIn || '—'} <small>{today?.clockOut ? `to ${today.clockOut}` : '/ pending'}</small></strong><em>{today?.mode || 'No attendance recorded yet'}</em></div></article></>}</section>

        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, and grace-period records.</p></div><article className="activity-card"><div className="history-list">{showSkeleton ? <><HistoryRowSkeleton /><HistoryRowSkeleton /><HistoryRowSkeleton /></> : history.map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button></nav>

      {modal && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {profileOpen && <div className="profile-backdrop" onClick={(event) => event.target === event.currentTarget && setProfileOpen(false)}><aside className="profile-drawer"><button className="drawer-close" aria-label="Close profile" onClick={() => setProfileOpen(false)}><X size={19} /></button><div className="drawer-avatar">{initials}</div><p className="eyebrow">INTERN PROFILE</p><h2>{displayName}</h2><div className="credential-list"><div><span>Department</span><strong>{intern?.department_name || '—'}</strong></div><div><span>Rizurf account</span><strong>{me?.email || '—'}</strong></div></div><div className="drawer-setting"><span><Bell size={18} /> Clock in/out reminder</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><i></i></button></div><div className="drawer-setting"><span>{theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />} Dark mode</span><button className={theme === 'dark' ? 'toggle is-on' : 'toggle'} aria-pressed={theme === 'dark'} onClick={toggleTheme}><i></i></button></div><div className="drawer-setting"><span><ShieldCheck size={18} /> My device</span><strong>{device?.linked ? (device.isYou ? 'Linked to you' : 'Linked elsewhere') : 'Not linked yet'}</strong></div>{device?.linked && device?.isYou && <button className="drawer-setting drawer-action" onClick={releaseDevice}><Settings size={18} /> Unlink this device</button>}<p className="drawer-note">{device?.linked
        ? (device.isYou ? 'Clocking in from this device works only for you, on this device, until you unlink it.' : 'This device already clocked in a different intern, so it can\'t be used for your account.')
        : 'The first time you clock in, this device links to you -- after that, no one else can clock in from it.'}</p><button className="drawer-setting drawer-action logout-button" onClick={signOut}><LogOut size={18} /> Sign out</button><p className="drawer-note">Ends your session in this app and takes you to the Rizurf gateway. If you're still signed in there, opening this app again may sign you straight back in.</p></aside></div>}
    </div>
  )
}

export default App
