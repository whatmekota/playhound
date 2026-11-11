package io.github.whatmekota.playhound.usb

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * USB serial over OTG (an OSR2, SR6 or SSR1 on a cable), through
 * usb-serial-for-android: CH34x, CP210x, FTDI, PL2303 and CDC ACM (an ESP32-S3
 * or an Arduino on its own USB). src/lib/android/serial.ts turns it into the
 * Web Serial port the TCode pipeline already uses.
 *
 * - list: the serial devices plugged in, with whether access is granted
 * - requestPermission: Android's "Allow playhound to access …?" dialog
 * - open / close / write / setSignals: one port per device
 * - setPanic: bytes to send if the app closes before the page can stop the
 *   device (TCode that homes every axis); SerialPanic sends them
 * - events: "data" (bytes read), "closed" (the port went away: cable pulled,
 *   or an error), "attached" / "detached" (a USB device came or went)
 *
 * Bytes cross the bridge as base64.
 */
@CapacitorPlugin(name = "PhUsbSerial")
class UsbSerialPlugin : Plugin() {
    private class Open(
        val id: String,
        val port: UsbSerialPort,
        val io: SerialInputOutputManager,
        val writer: ExecutorService,
    ) {
        @Volatile var panic: ByteArray? = null
    }

    private val ports = ConcurrentHashMap<String, Open>()
    private val usb: UsbManager get() = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private var receiver: BroadcastReceiver? = null
    private val permissionCalls = ConcurrentHashMap<String, PluginCall>()

    override fun load() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val device = intent.usbDevice() ?: return
                when (intent.action) {
                    ACTION_PERMISSION -> {
                        val call = permissionCalls.remove(device.deviceName) ?: return
                        val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) || usb.hasPermission(device)
                        call.resolve(JSObject().put("granted", granted))
                    }
                    UsbManager.ACTION_USB_DEVICE_ATTACHED -> notifyListeners("attached", JSObject().put("device", describe(device)))
                    UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                        val id = device.deviceName
                        // The read thread usually notices first; either way, once.
                        closePort(id, "The device was unplugged")
                        notifyListeners("detached", JSObject().put("id", id))
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        // The permission answer comes back through our own PendingIntent, and
        // attach / detach are system broadcasts: neither needs an exported receiver.
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    override fun handleOnDestroy() {
        // The page that owned these is going; leave the device at rest, not mid-stroke.
        for (id in ports.keys.toList()) closePort(id, null, sendPanic = true)
        receiver?.let {
            try {
                context.unregisterReceiver(it)
            }
            catch (_: IllegalArgumentException) {
            }
        }
        receiver = null
        for (c in permissionCalls.values) c.reject("The app is closing")
        permissionCalls.clear()
    }

    private fun drivers(): List<UsbSerialDriver> = UsbSerialProber.getDefaultProber().findAllDrivers(usb)

    private fun driverFor(id: String): UsbSerialDriver? = drivers().firstOrNull { it.device.deviceName == id }

    private fun describe(device: UsbDevice, driver: UsbSerialDriver? = null): JSObject {
        val d = driver ?: UsbSerialProber.getDefaultProber().probeDevice(device)
        val o = JSObject()
            .put("id", device.deviceName)
            .put("vendorId", device.vendorId)
            .put("productId", device.productId)
            .put("driver", d?.let { driverName(it) })
            .put("permitted", usb.hasPermission(device))
            .put("open", ports.containsKey(device.deviceName))
        // Names need permission on Android 10 and later; without it they throw.
        try {
            device.productName?.let { o.put("product", it) }
            device.manufacturerName?.let { o.put("manufacturer", it) }
        }
        catch (_: SecurityException) {
        }
        return o
    }

    /** Serial devices plugged in (and how many other USB devices there are). */
    @PluginMethod
    fun list(call: PluginCall) {
        try {
            val found = drivers()
            val arr = JSArray()
            for (d in found) arr.put(describe(d.device, d))
            call.resolve(
                JSObject()
                    .put("devices", arr)
                    .put("others", usb.deviceList.size - found.size)
                    .put("host", context.packageManager.hasSystemFeature("android.hardware.usb.host")),
            )
        }
        catch (e: Exception) {
            call.reject(e.message ?: "Could not list USB devices")
        }
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No device")
        val device = usb.deviceList[id] ?: return call.reject("That device is not plugged in any more", "GONE")
        if (usb.hasPermission(device)) return call.resolve(JSObject().put("granted", true))
        permissionCalls.put(id, call)?.reject("Asked again")
        // Android 14 wants an explicit intent behind a mutable PendingIntent,
        // and the system has to add its answer (the extras): hence MUTABLE.
        val intent = Intent(ACTION_PERMISSION).setPackage(context.packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        usb.requestPermission(device, PendingIntent.getBroadcast(context, id.hashCode(), intent, flags))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No device")
        if (ports.containsKey(id)) return call.reject("The port is already open", "BUSY")
        val driver = driverFor(id) ?: return call.reject("That device is not plugged in any more", "GONE")
        if (!usb.hasPermission(driver.device)) return call.reject("playhound has no access to this device yet", "DENIED")
        val connection = usb.openDevice(driver.device) ?: return call.reject("Android would not open the device", "OPEN")
        val port = driver.ports.firstOrNull() ?: return call.reject("The device has no serial port", "OPEN")
        try {
            port.open(connection)
            port.setParameters(
                call.getInt("baudRate", 115200)!!,
                call.getInt("dataBits", 8)!!,
                when (call.getInt("stopBits", 1)) {
                    2 -> UsbSerialPort.STOPBITS_2
                    else -> UsbSerialPort.STOPBITS_1
                },
                when (call.getString("parity", "none")) {
                    "even" -> UsbSerialPort.PARITY_EVEN
                    "odd" -> UsbSerialPort.PARITY_ODD
                    else -> UsbSerialPort.PARITY_NONE
                },
            )
            // As a desktop browser leaves them: both asserted. On an ESP32's
            // auto-reset circuit, both alike means "run", not "reset".
            trySignals(port, dtr = true, rts = true)
        }
        catch (e: Exception) {
            try {
                port.close()
            }
            catch (_: Exception) {
            }
            return call.reject("The port did not open: ${e.message}", "OPEN")
        }
        val io = SerialInputOutputManager(
            port,
            object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    notifyListeners("data", JSObject().put("id", id).put("data", Base64.encodeToString(data, Base64.NO_WRAP)))
                }

                override fun onRunError(e: Exception) {
                    // Pulling the cable lands here first (an IOException from the read).
                    closePort(id, e.message ?: "The device stopped answering")
                }
            },
        )
        val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "ph-usb-write").apply { isDaemon = true } }
        val open = Open(id, port, io, writer)
        ports[id] = open
        SerialPanic.register(id) { panicNow(open) }
        io.start()
        call.resolve(describe(driver.device, driver))
    }

    private fun trySignals(port: UsbSerialPort, dtr: Boolean?, rts: Boolean?) {
        try {
            if (dtr != null) port.dtr = dtr
            if (rts != null) port.rts = rts
        }
        catch (e: Exception) {
            // Some chips have no control lines; that is fine for TCode.
            Log.i(TAG, "signals: ${e.message}")
        }
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val open = ports[call.getString("id") ?: ""] ?: return call.reject("The port is closed", "CLOSED")
        val bytes = try {
            Base64.decode(call.getString("data") ?: "", Base64.DEFAULT)
        }
        catch (e: IllegalArgumentException) {
            return call.reject("Not base64")
        }
        try {
            open.writer.execute {
                try {
                    open.port.write(bytes, WRITE_TIMEOUT_MS)
                    call.resolve()
                }
                catch (e: Exception) {
                    call.reject("The device has been lost: ${e.message}", "LOST")
                }
            }
        }
        catch (_: java.util.concurrent.RejectedExecutionException) {
            call.reject("The port is closed", "CLOSED")
        }
    }

    @PluginMethod
    fun setSignals(call: PluginCall) {
        val open = ports[call.getString("id") ?: ""] ?: return call.reject("The port is closed", "CLOSED")
        trySignals(open.port, call.getBoolean("dtr"), call.getBoolean("rts"))
        call.resolve()
    }

    @PluginMethod
    fun setPanic(call: PluginCall) {
        val open = ports[call.getString("id") ?: ""] ?: return call.resolve()
        val data = call.getString("data")
        open.panic = if (data.isNullOrEmpty()) null else Base64.decode(data, Base64.DEFAULT)
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        closePort(call.getString("id") ?: "", null)
        call.resolve()
    }

    /** Write the panic bytes now, from whatever thread, without waiting long. */
    private fun panicNow(open: Open) {
        val bytes = open.panic ?: return
        try {
            open.port.write(bytes, PANIC_TIMEOUT_MS)
        }
        catch (e: Exception) {
            Log.w(TAG, "panic write: ${e.message}")
        }
    }

    /** Close a port once; `reason` non-null tells the page it was lost rather than closed. */
    private fun closePort(id: String, reason: String?, sendPanic: Boolean = false) {
        val open = ports.remove(id) ?: return
        SerialPanic.unregister(id)
        if (sendPanic) panicNow(open)
        open.writer.shutdownNow()
        try {
            open.io.stop()
        }
        catch (_: Exception) {
        }
        try {
            open.port.close()
        }
        catch (_: Exception) {
        }
        if (reason != null) notifyListeners("closed", JSObject().put("id", id).put("reason", reason))
    }

    private companion object {
        const val TAG = "PhUsbSerial"
        const val ACTION_PERMISSION = "io.github.whatmekota.playhound.USB_PERMISSION"
        const val WRITE_TIMEOUT_MS = 1000
        const val PANIC_TIMEOUT_MS = 300
    }
}

@Suppress("DEPRECATION")
private fun Intent.usbDevice(): UsbDevice? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
    else getParcelableExtra(UsbManager.EXTRA_DEVICE)

/** A short name for the chip family, for the picker. */
internal fun driverName(d: UsbSerialDriver): String = driverLabel(d.javaClass.simpleName)

/** "Ch34xSerialDriver" → "CH34x", and so on; unknown ones keep their class name, shortened. */
internal fun driverLabel(className: String): String = when (className) {
    "Ch34xSerialDriver" -> "CH34x"
    "Cp21xxSerialDriver" -> "CP210x"
    "FtdiSerialDriver" -> "FTDI"
    "ProlificSerialDriver" -> "PL2303"
    "CdcAcmSerialDriver" -> "USB CDC"
    "GsmModemSerialDriver" -> "GSM modem"
    "ChromeCcdSerialDriver" -> "Chrome CCD"
    else -> className.removeSuffix("SerialDriver")
}
