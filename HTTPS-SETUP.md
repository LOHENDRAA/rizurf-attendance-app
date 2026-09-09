# HTTPS on iPhone

## Production recommendation

Do not use the local mkcert certificate for employees. It is trusted only on the development computer unless every device installs the local CA.

For employee phones, host this app at a real hostname such as `attendance.yourcompany.com` and use a publicly trusted certificate from Let's Encrypt or your hosting provider. One certificate on the server is then trusted automatically by iOS, Android, Chrome, and Safari.

The database can remain on the XAMPP/MySQL server if the server is reachable by the hosted application, or the complete PHP app can be deployed to a PHP/MySQL host.

Alternative for internal-only testing: use a company-managed internal certificate authority through MDM. The CA is then installed centrally on managed employee devices, not manually one by one.

## Local development only

XAMPP Apache is configured for HTTPS with a local mkcert certificate that covers `localhost` and `192.168.3.69`. This is only for testing on devices where the CA has already been trusted.

## Open the app

On the office Wi-Fi, open this on the iPhone:

```text
https://192.168.3.69/qr-system/
```

Do not use `http://` when testing the camera.

## Trust the local certificate on iPhone (development only)

The certificate is issued by mkcert, so iOS must trust the local CA once:

1. On the development computer, run `mkcert -CAROOT`.
2. Send the `rootCA.pem` file from that folder to the iPhone using AirDrop or email.
3. Open the file on the iPhone and install the profile in **Settings > Profile Downloaded**.
4. Go to **Settings > General > About > Certificate Trust Settings**.
5. Enable full trust for the mkcert root certificate.
6. Reopen `https://192.168.3.69/qr-system/` and allow camera and location access.

If the certificate was already trusted and the page still does not open, restart Apache from XAMPP and reload the URL.

## Important

The iPhone and the XAMPP computer must be on the same Wi-Fi network. The computer's LAN address can change; check it with `ipconfig` and use the current Wi-Fi IPv4 address in the HTTPS URL.
