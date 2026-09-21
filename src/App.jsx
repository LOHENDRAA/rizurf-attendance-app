import { useEffect, useRef, useState } from 'react'
import {
  Bell, Briefcase, Check, ChevronLeft, ChevronRight, Clock3, Download, FileScan,
  Home, LogOut, MapPin, Moon, QrCode, ScanLine, Smartphone,
  ShieldCheck, Sun, X,
} from 'lucide-react'
import { Html5Qrcode } from 'html5-qrcode'
import QRCode from 'qrcode'
import './App.css'

const OFFICE_ADDRESS_FALLBACK = 'First Floor, 28-1, Jln 1/116B, Sri Desa Entrepreneur Park'
// Bootstrap default only, for the brief window before /api/me resolves --
// the real, current value (which an admin can change) is me.office.qr.
// Using a stale hardcoded value here would make scanning fail right after
// a regenerate, since this constant would no longer match the printed code.
const QR_PAYLOAD_FALLBACK = 'Rizurf_Attandance'
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

function todayIsoDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatMonthLabel(monthStr) {
  const [year, month] = monthStr.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
}

// Weeks of a calendar month grid, Sunday-first, with null placeholders so
// the first/last week still line up under the right weekday columns.
function buildMonthGrid(monthStr) {
  const [year, month] = monthStr.split('-').map(Number)
  const daysInMonth = new Date(year, month, 0).getDate()
  const startWeekday = new Date(year, month - 1, 1).getDay()
  const cells = Array(startWeekday).fill(null)
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

function statusDotClass(status) {
  if (status === 'Late') return 'late'
  if (status === 'Excused (MC)') return 'excused'
  return 'ontime'
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
  const [devices, setDevices] = useState([])
  const [historyMonth, setHistoryMonth] = useState(() => todayIsoDate().slice(0, 7))
  const [historyMonthRecords, setHistoryMonthRecords] = useState([])
  const [historyMonthLoading, setHistoryMonthLoading] = useState(false)
  const [adminDate, setAdminDate] = useState(todayIsoDate)
  const [adminRecords, setAdminRecords] = useState([])
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminCalendarMonth, setAdminCalendarMonth] = useState(() => todayIsoDate().slice(0, 7))
  const [adminCalendarDays, setAdminCalendarDays] = useState([])
  const [adminFilterIntern, setAdminFilterIntern] = useState(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [avatarFailed, setAvatarFailed] = useState(false)
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

  const loadDevices = () => fetch('./api/devices.php')
    .then((response) => response.json())
    .then((data) => { if (data.success) setDevices(data.devices) })
    .catch(() => {})

  useEffect(() => { loadDevices() }, [])

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

  // Unlinks one device from your account -- any device in the list, not
  // just the one you're using right now (e.g. logging out an old phone
  // remotely), the way WhatsApp's own linked-devices list works. Not a way
  // to bump someone else off their own device: the server only ever removes
  // a device that's actually yours.
  const unlinkDevice = (deviceId) => {
    fetch('./api/devices.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setDevices(data.devices)
        showNotice('success', 'That device has been unlinked.')
      })
      .catch((error) => showNotice('error', error.message || 'Could not unlink that device.'))
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
    const payload = { action, mode, qrToken: mode === 'Office' ? currentQr : null, latitude: window.lastAttendanceLatitude || null, longitude: window.lastAttendanceLongitude || null, accuracy: window.lastAttendanceAccuracy || null }
    fetch('./api/attendance.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setToday(data.today)
        setHistory(data.records)
        loadDevices()
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
    const config = { fps: 10, qrbox: { width: 220, height: 220 } }
    const onDecoded = (decodedText) => {
      if (scanHandledRef.current) return
      if (decodedText.trim() !== currentQr) {
        setScannerError(`QR read as “${decodedText.trim()}”, but the expected value is “${currentQr}”.`)
        return
      }
      scanHandledRef.current = true
      stopScanner()
      verifyOfficeLocation()
    }

    try {
      await scanner.start({ facingMode: 'environment' }, config, onDecoded, () => {})
      return
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setScannerError('Camera access was blocked. Allow camera permission for this site, or use the QR image upload below.')
        return
      }
      // Some Android browsers (seen on Honor/Huawei devices) reject a bare
      // facingMode constraint outright -- before ever prompting for
      // permission -- because they can't resolve which physical camera
      // satisfies it. Falling back to an explicit camera id, picked from
      // the device's own enumeration, is html5-qrcode's own documented
      // workaround for this exact class of device.
    }
    try {
      const cameras = await Html5Qrcode.getCameras()
      if (!cameras.length) {
        setScannerError('No camera was found on this device. Use the QR image upload below or choose Hybrid.')
        return
      }
      const rearCamera = cameras.find((camera) => /back|rear|environment/i.test(camera.label)) || cameras[cameras.length - 1]
      await scanner.start(rearCamera.id, config, onDecoded, () => {})
    } catch (error) {
      setScannerError(error?.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow camera permission for this site, or use the QR image upload below.'
        : 'Could not start the camera on this device. Use the QR image upload below or choose Hybrid.')
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
      if (decodedText.trim() !== currentQr) {
        setScanStatus('')
        setScannerError(`QR read as “${decodedText.trim()}”, but the expected value is “${currentQr}”.`)
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
    setScannerError('')
    // Clock-out must use the same mode you clocked in with -- the backend
    // enforces this and rejects a mismatch, so there's no real choice to
    // offer here; skip straight to whichever mode that actually is instead
    // of showing a picker where one of the two options is guaranteed to fail.
    if (isClockedIn && today?.mode) {
      chooseMode(today.mode)
      return
    }
    setModal('mode')
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
  const photoUrl = intern?.photo_url && !avatarFailed ? intern.photo_url : null
  const officeAddress = me?.office?.address || OFFICE_ADDRESS_FALLBACK
  const currentQr = me?.office?.qr || QR_PAYLOAD_FALLBACK
  const isAdmin = me?.role === 'admin'

  const loadAdminAttendance = (date) => {
    setAdminLoading(true)
    fetch(`./api/admin/attendance.php?date=${date}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setAdminRecords(data.records)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load attendance for that date.'))
      .finally(() => setAdminLoading(false))
  }

  const loadAdminCalendar = (month, internId) => {
    const query = internId ? `month=${month}&intern=${internId}` : `month=${month}`
    fetch(`./api/admin/attendance-calendar.php?${query}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setAdminCalendarDays(data.days)
      })
      .catch(() => {}) // best-effort -- day badges just stay empty, the list below still works
  }

  const shiftAdminMonth = (delta) => {
    const [year, month] = adminCalendarMonth.split('-').map(Number)
    const next = new Date(year, month - 1 + delta, 1)
    setAdminCalendarMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  // Clicking the already-filtered intern's name again clears the filter.
  const toggleAdminFilterIntern = (record) => {
    setAdminFilterIntern((previous) => (previous?.id === record.internId ? null : { id: record.internId, name: record.internName }))
  }

  const loadHistoryMonth = (month) => {
    setHistoryMonthLoading(true)
    fetch(`./api/attendance.php?month=${month}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setHistoryMonthRecords(data.records)
      })
      .catch((error) => showNotice('error', error.message || 'Could not load that month.'))
      .finally(() => setHistoryMonthLoading(false))
  }

  const shiftHistoryMonth = (delta) => {
    const [year, month] = historyMonth.split('-').map(Number)
    const next = new Date(year, month - 1 + delta, 1)
    setHistoryMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (isAdmin && activeTab === 'admin') loadAdminAttendance(adminDate)
  }, [isAdmin, activeTab, adminDate])
  useEffect(() => {
    if (isAdmin && activeTab === 'admin') loadAdminCalendar(adminCalendarMonth, adminFilterIntern?.id)
  }, [isAdmin, activeTab, adminCalendarMonth, adminFilterIntern])
  useEffect(() => {
    if (activeTab === 'history') loadHistoryMonth(historyMonth)
  }, [activeTab, historyMonth])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  const adminCalendarWeeks = buildMonthGrid(adminCalendarMonth)
  const adminCalendarByDate = Object.fromEntries(adminCalendarDays.map((day) => [day.date, day]))
  const historyWeeks = buildMonthGrid(historyMonth)
  const historyByDate = Object.fromEntries(historyMonthRecords.map((record) => [record.rawDate, record]))
  const todayDate = todayIsoDate()
  const visibleAdminRecords = adminFilterIntern ? adminRecords.filter((record) => record.internId === adminFilterIntern.id) : adminRecords

  // The QR image is rendered client-side from whatever the current code
  // actually is -- never a separate fetch, so it can never drift from what
  // /api/me already says (and what attendance.php will actually accept).
  useEffect(() => {
    QRCode.toDataURL(currentQr, { margin: 1, width: 220 }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [currentQr])

  // Retry a fresh photo_url (e.g. after re-signing in) instead of staying
  // stuck on initials because an earlier, different URL once failed to load.
  useEffect(() => {
    setAvatarFailed(false)
  }, [intern?.photo_url])

  const regenerateQr = () => {
    fetch('./api/admin/qr.php', { method: 'POST' })
      .then((response) => response.json())
      .then((data) => {
        if (!data.success) throw new Error(data.message)
        setMe((previous) => (previous ? { ...previous, office: { ...previous.office, qr: data.qr } } : previous))
        showNotice('success', 'Office QR regenerated. Update the printed/displayed code now -- the old one no longer works.')
      })
      .catch((error) => showNotice('error', error.message || 'Could not regenerate the office QR.'))
  }

  // A larger, print-friendly render of the same code the admin is currently
  // looking at -- generated on demand rather than reusing the 220px on-screen
  // image, so the saved file still looks sharp at office-sign size.
  const downloadQr = () => {
    QRCode.toDataURL(currentQr, { margin: 2, width: 512 })
      .then((url) => {
        const link = document.createElement('a')
        link.href = url
        link.download = `rizurf-office-qr-${new Date().toISOString().slice(0, 10)}.png`
        link.click()
      })
      .catch(() => showNotice('error', 'Could not save the QR image.'))
  }

  /* oxlint-disable react-hooks/exhaustive-deps, react(set-state-in-effect) */
  useEffect(() => {
    if (modal === 'scan') startScanner()
    return () => { stopScanner() }
  }, [modal])
  /* oxlint-enable react-hooks/exhaustive-deps, react(set-state-in-effect) */

  return (
    <div className="app-shell">
      <header className="topbar">
        <img src={theme === 'dark' ? './rizurf-logo-dark.png' : './rizurf-logo-light.png'} alt="Rizurf Realty" className="topbar-logo" />
        <div className="topbar-actions"><span className="system-status"><i></i> All systems operational</span>{meLoaded ? <button className="profile-chip" aria-label="Open profile" onClick={() => selectTab('profile')}>{photoUrl ? <img src={photoUrl} alt="" className="avatar" onError={() => setAvatarFailed(true)} /> : <span className="avatar">{initials}</span>}<span className="profile-name">{displayName}</span><ChevronRight size={15} /></button> : <ProfileChipSkeleton />}</div>
      </header>

      <main id="overview" className={`tab-content ${activeTab}-tab`}>
        {showSkeleton ? <WelcomeRowSkeleton /> : <section className="welcome-row"><div><p className="eyebrow">{formatDate(new Date())}</p><h1>Good morning, {firstName}</h1><p className="subtitle">Record your workday in a few seconds.</p></div><div className="location-pill"><Briefcase size={15} /> {intern?.department_name || 'Rizurf'}</div></section>}
        {notLinked && <div className="notice error" role="status"><X size={17} />{me.reason === 'lookup_failed'
          ? `Could not reach the Intern Database${me.detail ? ` (${me.detail})` : ''}. Your attendance will load once it is back.`
          : `Your Rizurf account${me?.email ? ` (${me.email})` : ''} isn't linked to an intern record yet. Ask an admin to add you in the Intern Database.`}</div>}
        {notice && <div className={`notice ${notice.type}`} role="status">{notice.type === 'success' ? <Check size={17} /> : <X size={17} />}{notice.message}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        <section className="attendance-hero">{showSkeleton ? <HeroSkeleton /> : <div className="hero-copy"><p className="eyebrow">TODAY'S ATTENDANCE</p><h2>{isClockedIn ? 'You are clocked in' : today?.clockOut ? 'Workday complete' : 'Ready to clock in?'}</h2><p>{isClockedIn ? `Started at ${today.clockIn} via ${today.mode}. Clock out when you finish.` : today?.clockOut ? `Clocked out at ${today.clockOut} via ${today.clockOutMode || today.mode}.` : 'Choose Office if you are at work, or Hybrid if you are working away.'}</p><div className="attendance-actions"><button className={today?.clockOut ? 'primary-button checked-in' : 'primary-button'} onClick={openAttendance} disabled={Boolean(today?.clockOut)}>{today?.clockOut ? <><Check size={18} /> Attendance complete</> : <><Clock3 size={18} /> Clock {action}</>}</button></div><span className="location-note"><ShieldCheck size={14} /> Office location within 100m · Mobile data supported</span></div>}<div className="hero-location"><div className="location-orbit"><MapPin size={35} /></div><strong>Office verification</strong><span>100m radius from the office</span><small>{officeAddress}</small></div></section>

        <section className="quick-grid">{showSkeleton ? <><MetricCardSkeleton /><MetricCardSkeleton /></> : <><article className="metric-card accent-card"><div className="metric-icon"><Clock3 size={19} /></div><div><p>Late arrivals</p><strong>{history.filter((entry) => entry.status === 'Late').length} <small>times</small></strong><em>This month</em></div></article><article className="metric-card"><div className="metric-icon pale"><Clock3 size={19} /></div><div><p>Today</p><strong>{today?.clockIn || '—'} <small>{today?.clockOut ? `to ${today.clockOut}` : '/ pending'}</small></strong><em>{today?.mode || 'No attendance recorded yet'}</em></div></article></>}</section>

        {activeTab === 'history' && <section className="tab-panel logs-panel"><div className="tab-heading"><p className="eyebrow">ATTENDANCE LOGS</p><h1>My attendance history</h1><p>Clock-ins, clock-outs, late arrivals, and grace-period records.</p></div><article className="activity-card"><div className="admin-calendar"><div className="admin-calendar-header"><button className="icon-button" aria-label="Previous month" onClick={() => shiftHistoryMonth(-1)}><ChevronLeft size={18} /></button><strong>{formatMonthLabel(historyMonth)}</strong><button className="icon-button" aria-label="Next month" onClick={() => shiftHistoryMonth(1)}><ChevronRight size={18} /></button></div><div className="admin-calendar-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div className="admin-calendar-grid">{historyWeeks.map((week, weekIndex) => week.map((date, dayIndex) => date ? <div key={date} className={`admin-calendar-day${date === todayDate ? ' is-today' : ''}`}><span className="admin-calendar-daynum">{Number(date.slice(8, 10))}</span>{historyByDate[date] && <span className={`history-dot ${statusDotClass(historyByDate[date].status)}`} title={historyByDate[date].status}></span>}</div> : <span key={`${weekIndex}-${dayIndex}`} className="admin-calendar-day empty"></span>))}</div></div><div className="history-list">{historyMonthLoading ? <><HistoryRowSkeleton /><HistoryRowSkeleton /><HistoryRowSkeleton /></> : historyMonthRecords.length === 0 ? <p className="drawer-note">No attendance recorded this month.</p> : historyMonthRecords.slice().reverse().map((entry) => <div className="history-row" key={`log-${entry.id}`}><div className="history-date"><strong>{entry.date.split(',')[0]}</strong><span>{entry.date.split(',').slice(1).join(',')}</span></div><div className="history-times"><strong>{entry.clockIn || '—'}</strong><span>{entry.clockOut ? `to ${entry.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{entry.mode}</span><span className={`status-tag ${entry.status === 'On time' ? 'green' : entry.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{entry.status}</span></div>)}</div></article></section>}

        {activeTab === 'admin' && isAdmin && <section className="tab-panel admin-panel"><div className="tab-heading"><p className="eyebrow">ADMIN</p><h1>Attendance overview</h1><p>Every intern's attendance, and the office QR code.</p></div><article className="activity-card admin-qr-card"><div className="section-heading"><div><p className="eyebrow">OFFICE QR</p><h2>Current code</h2></div><div className="admin-qr-actions"><button className="secondary-action" onClick={downloadQr}><Download size={16} /> Save QR</button><button className="secondary-action" onClick={regenerateQr}><QrCode size={16} /> Regenerate</button></div></div>{qrDataUrl && <img src={qrDataUrl} alt="Office QR code" className="admin-qr-image" />}<p className="drawer-note">Regenerating invalidates the old code immediately -- update the printed or displayed copy at the office right away.</p></article><article className="activity-card"><div className="section-heading"><div><p className="eyebrow">ALL ATTENDANCE</p><h2>{adminDate}</h2></div>{adminFilterIntern && <button className="filter-chip" onClick={() => setAdminFilterIntern(null)}>{adminFilterIntern.name}<X size={13} /></button>}</div><div className="admin-calendar"><div className="admin-calendar-header"><button className="icon-button" aria-label="Previous month" onClick={() => shiftAdminMonth(-1)}><ChevronLeft size={18} /></button><strong>{formatMonthLabel(adminCalendarMonth)}</strong><button className="icon-button" aria-label="Next month" onClick={() => shiftAdminMonth(1)}><ChevronRight size={18} /></button></div><div className="admin-calendar-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div><div className="admin-calendar-grid">{adminCalendarWeeks.map((week, weekIndex) => week.map((date, dayIndex) => date ? <button key={date} className={`admin-calendar-day${date === adminDate ? ' selected' : ''}${date === todayDate ? ' is-today' : ''}`} onClick={() => setAdminDate(date)}><span className="admin-calendar-daynum">{Number(date.slice(8, 10))}</span>{adminCalendarByDate[date] && <span className="admin-calendar-count">{adminCalendarByDate[date].total}</span>}{adminCalendarByDate[date]?.late > 0 && <span className="admin-calendar-late-dot" title={`${adminCalendarByDate[date].late} late`}></span>}</button> : <span key={`${weekIndex}-${dayIndex}`} className="admin-calendar-day empty"></span>))}</div></div><div className="history-list">{adminLoading ? <p className="drawer-note">Loading...</p> : visibleAdminRecords.length === 0 ? <p className="drawer-note">{adminFilterIntern ? `No attendance for ${adminFilterIntern.name} on this date.` : 'No attendance recorded for this date.'}</p> : visibleAdminRecords.map((record) => <div className="history-row" key={record.id}><div className="history-date"><button className="intern-name-button" onClick={() => toggleAdminFilterIntern(record)}>{record.internName}</button><span>{record.refNumber}</span></div><div className="history-times"><strong>{record.clockIn || '—'}</strong><span>{record.clockOut ? `to ${record.clockOut}` : 'Still working'}</span></div><span className="mode-tag">{record.mode}</span><span className={`status-tag ${record.status === 'On time' ? 'green' : record.status === 'Excused (MC)' ? 'excused' : 'orange'}`}>{record.status}</span></div>)}</div></article></section>}
      </main>
      <footer><span>Rizurf People Ops</span><span>Attendance service <b></b> All systems operational</span></footer>

      <nav className="bottom-nav" aria-label="Primary navigation"><button className={activeTab === 'home' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('home')}><Home size={21} /><span>Home</span></button><button className="nav-tab scan-tab" onClick={() => selectTab('scan')}><span className="scan-button"><ScanLine size={24} /></span><span>Scan</span></button><button className={activeTab === 'history' ? 'nav-tab active' : 'nav-tab'} onClick={() => selectTab('history')}><Clock3 size={21} /><span>History</span></button></nav>

      {modal && <div className="modal-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && setModal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="attendance-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>{modal === 'mode' ? <><div className="modal-icon"><Clock3 size={22} /></div><p className="eyebrow">CLOCK {action.toUpperCase()}</p><h2 id="attendance-modal-title">How are you working today?</h2><p className="modal-subtitle">We will verify your attendance based on where you are.</p><div className="mode-options"><button className="mode-option" onClick={() => chooseMode('Office')}><span className="mode-icon office"><QrCode size={21} /></span><span><strong>At the office</strong><small>Scan QR and verify within 100m</small></span><ChevronRight size={17} /></button><button className="mode-option" onClick={() => chooseMode('Hybrid')}><span className="mode-icon hybrid"><MapPin size={21} /></span><span><strong>Hybrid / away</strong><small>Clock {action} without office QR</small></span><ChevronRight size={17} /></button></div></> : <><div className="modal-icon"><QrCode size={22} /></div><p className="eyebrow">OFFICE QR VERIFICATION</p><h2 id="attendance-modal-title">Scan the office QR</h2><p className="modal-subtitle">Scan the QR code provided by Rizurf, then stay within 100m while location is checked.</p><div id="qr-reader" className="qr-reader"></div>{scanStatus && <p className="scanner-status">{scanStatus}</p>}{scannerError && <p className="scanner-error">{scannerError}</p>}<label className="upload-qr"><FileScan size={16} /> Use a QR image<input type="file" accept="image/*" capture="environment" onChange={scanQrImage} /></label><button className="text-button cancel-scan" onClick={() => setModal(null)}>Cancel scan</button></>}</div></div>}
      {profileOpen && <div className="profile-backdrop" onClick={(event) => event.target === event.currentTarget && setProfileOpen(false)}><aside className="profile-drawer"><button className="drawer-close" aria-label="Close profile" onClick={() => setProfileOpen(false)}><X size={19} /></button>{photoUrl ? <img src={photoUrl} alt="" className="drawer-avatar" onError={() => setAvatarFailed(true)} /> : <div className="drawer-avatar">{initials}</div>}<p className="eyebrow">INTERN PROFILE</p><h2>{displayName}</h2><div className="credential-list"><div><span>Department</span><strong>{intern?.department_name || '—'}</strong></div><div><span>Rizurf account</span><strong>{me?.email || '—'}</strong></div></div><div className="drawer-setting"><span><Bell size={18} /> Clock in/out reminder</span><button className={notificationsEnabled ? 'toggle is-on' : 'toggle'} aria-pressed={notificationsEnabled} onClick={toggleNotifications}><i></i></button></div><div className="drawer-setting"><span>{theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />} Dark mode</span><button className={theme === 'dark' ? 'toggle is-on' : 'toggle'} aria-pressed={theme === 'dark'} onClick={toggleTheme}><i></i></button></div>{isAdmin && <button className="drawer-setting drawer-action" onClick={() => { setProfileOpen(false); selectTab('admin') }}><ShieldCheck size={18} /> Admin<ChevronRight size={16} style={{ marginLeft: 'auto' }} /></button>}<p className="eyebrow drawer-section-label"><ShieldCheck size={14} /> LINKED DEVICES</p>{devices.length > 0 ? <div className="device-list">{devices.map((d) => <button key={d.id} className="device-row" onClick={() => unlinkDevice(d.id)}><span className="device-icon"><Smartphone size={17} /></span><span className="device-info"><strong>{d.label}{d.isCurrent && <span className="device-current-tag"> · This device</span>}</strong><small>Last active {d.lastUsedAt}</small></span><X size={15} /></button>)}</div> : <p className="drawer-note">No devices linked yet. The first time you clock in, this device links to you -- after that, no one else can clock in from it.</p>}<button className="drawer-setting drawer-action logout-button" onClick={signOut}><LogOut size={18} /> Sign out</button><p className="drawer-note">Ends your session in this app and takes you to the Rizurf gateway. If you're still signed in there, opening this app again may sign you straight back in.</p></aside></div>}
    </div>
  )
}

export default App
