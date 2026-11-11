package io.github.whatmekota.playhound.session

import io.github.whatmekota.playhound.usb.SerialPanic
import io.github.whatmekota.playhound.usb.driverLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionTest {
    @Test
    fun locksFollowWhatIsGoingOn() {
        assertFalse(SessionState().wakeLock)
        assertFalse(SessionState(active = true).wakeLock)
        assertTrue(SessionState(active = true, playing = true).wakeLock)
        assertTrue(SessionState(active = true, network = true).wifiLock)
        // Nothing running holds nothing, whatever else it says.
        assertFalse(SessionState(active = false, playing = true, network = true).wakeLock)
        assertFalse(SessionState(active = false, playing = true, network = true).wifiLock)
    }

    @Test
    fun serialPanicReachesEveryPortOnceAndSurvivesOneFailing() {
        var a = 0
        var b = 0
        SerialPanic.register("a") { a++ }
        SerialPanic.register("bad") { throw IllegalStateException("cable pulled") }
        SerialPanic.register("b") { b++ }
        SerialPanic.fire()
        assertEquals(1, a)
        assertEquals(1, b)
        SerialPanic.unregister("a")
        SerialPanic.unregister("bad")
        SerialPanic.unregister("b")
        SerialPanic.fire()
        assertEquals(1, a)
        assertEquals(0, SerialPanic.count)
    }

    @Test
    fun chipNames() {
        assertEquals("CH34x", driverLabel("Ch34xSerialDriver"))
        assertEquals("CP210x", driverLabel("Cp21xxSerialDriver"))
        assertEquals("USB CDC", driverLabel("CdcAcmSerialDriver"))
        assertEquals("Something", driverLabel("SomethingSerialDriver"))
    }
}
