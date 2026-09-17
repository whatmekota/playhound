"""Preview of the eye geometry on the host.

Mirrors face.cpp constant for constant, including drawing into a sprite-sized
buffer so clipping shows up here too. P holds the dials; VARIANTS overrides them
so shapes can be compared side by side without a flash cycle.

    python _eyesim.py            # variant sheet
    python _eyesim.py <name>     # one variant, all states, both themes
"""
import math, sys
from PIL import Image, ImageDraw

BASE = dict(
    # The flick only ever extends past the OUTER corner, so the sprite has a
    # big margin on that side and almost none on the inner one. A symmetric
    # margin either clips the flick or wastes half the screen.
    BODY_W=108, MARGIN_IN=8, MARGIN_OUT=40, EYE_H=138, ECY=98, EYE_CY=100, EYE_GAP=20,
    LID_UP=32, LID_LO=13, IRIS_R=32,
    # UP_P well below 1 flattens the bell into a near-straight lid, which is
    # what the reference strokes actually are.
    UP_APEX=0.42, UP_P=0.38, LO_APEX=0.44, LO_P=0.80,
    LASH=20.0, LASH_BASE=6, FLICK=36, FLICK_RISE=0.42,
    BROW=True, BROW_GAP=18, BROW_T=9.0, BROW_ARC=1.0, BROW_TILT=10,
    UNDER=True, LOWER_T=2,
    IRIS_S=0.46, IRIS_DY=0, IRIS_FIX=None, HILITE=(-13,-13,8),
    # SLANT rotates the eye about its centre, so it drops the inner corner as
    # much as it lifts the outer one. LIFT raises only the outer end, anchored
    # at the inner corner - which is what "outer corner higher" usually means.
    # LIFT_POW shapes where the lift happens: 1.0 spreads it evenly and just
    # slopes the whole eye, higher values keep the body level and hook only the
    # last part of it upward.
    SLANT=0.13, LIFT=0, LIFT_POW=1.0,
    ANG=0.60,
    UP_SHAPE="bell", UP_EDGE_IN=0.30, UP_EDGE_OUT=0.12, RAMP_EASE=0.85,
    LO_SHAPE="flat", LO_EDGE=0.20, LO_EDGE_IN=None, LO_EDGE_OUT=None,
    # Pupil: "round" is an ellipse, "shield" is flat-topped with straight sides
    # and an elliptical bottom - the big black mass in the minimal references.
    PUPIL="round", PUPIL_W=0.34, PUPIL_H=0.56, PUPIL_FLAT=0.30,
    HILITE_SHAPE="dot",        # or "notch": a wedge bitten out of the pupil top
    INNER_SPIKE=0,             # long tapering point at the inner corner too
    LOWER_CROSS=False,         # crossing X lashes instead of teeth
)

# Nothing is ever deleted from here: every shape that has been previewed stays
# available, so `python _eyesim.py <letter>` can bring any of them back.
VARIANTS = {
    # -- tall almond / wing, the first pass -------------------------------
    "A  wing, balanced":    dict(BODY_W=108, MARGIN_OUT=40, ECY=94, EYE_CY=98, EYE_GAP=20,
                                 LID_UP=47, LID_LO=22, IRIS_R=29, SLANT=0.10,
                                 UP_APEX=0.36, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=34, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5, ANG=0.0,
                                 LO_SHAPE="bell"),
    "B  wing, sharper":     dict(BODY_W=108, MARGIN_OUT=40, ECY=94, EYE_CY=98, EYE_GAP=20,
                                 LID_UP=42, LID_LO=18, IRIS_R=29, SLANT=0.17,
                                 UP_APEX=0.32, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=40, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5, ANG=0.0,
                                 LO_SHAPE="bell"),
    "C  wing, rounder":     dict(BODY_W=108, MARGIN_OUT=40, ECY=94, EYE_CY=98, EYE_GAP=20,
                                 LID_UP=51, LID_LO=29, IRIS_R=29, SLANT=0.07,
                                 UP_APEX=0.43, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=26, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5, ANG=0.0,
                                 LO_SHAPE="bell"),
    "F  wing, tareme":      dict(BODY_W=108, MARGIN_OUT=40, ECY=94, EYE_CY=98, EYE_GAP=20,
                                 LID_UP=47, LID_LO=27, IRIS_R=29, SLANT=-0.06,
                                 UP_APEX=0.52, UP_P=0.78, LO_APEX=0.52, LO_P=0.95,
                                 LASH=13.0, LASH_BASE=5, FLICK=20, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5, ANG=0.0,
                                 LO_SHAPE="bell"),

    # -- flat slot, from the heart sheet ----------------------------------
    "G  flat slot":          {},
    "H  flatter, heavier":   dict(LID_UP=27, LID_LO=11, LASH=27.0, LASH_BASE=8,
                                  FLICK=40, FLICK_RISE=0.30, IRIS_R=33),
    "I  sharp, small iris":  dict(LID_UP=35, LID_LO=14, UP_APEX=0.34, UP_P=0.52,
                                  SLANT=0.20, IRIS_R=25, FLICK=40, FLICK_RISE=0.55,
                                  LASH=17.0, BROW_GAP=11, BROW_T=5.0),
    # The crimson reference: almond rather than slot, a flat red iris with one
    # small high highlight, a hook that turns DOWN past the outer corner
    # (negative rise), and a thin sparse brow set well back.
    "K  crimson":            dict(LID_UP=36, LID_LO=15, UP_APEX=0.40, UP_P=0.62,
                                  LO_APEX=0.46, LO_P=0.85, SLANT=0.10,
                                  IRIS_R=30, IRIS_S=0.47, IRIS_DY=-1,
                                  IRIS_FIX=((122,6,10),(224,26,28)),
                                  HILITE=(-2,-15,6),
                                  LASH=21.0, LASH_BASE=6, FLICK=34, FLICK_RISE=-0.30,
                                  BROW_GAP=26, BROW_T=2.0, BROW_TILT=6,
                                  UNDER=True, LOWER_T=2, ANG=0.70),

    "J  extreme lash mass":  dict(LID_UP=24, LID_LO=10, LASH=34.0, LASH_BASE=10,
                                  FLICK=40, FLICK_RISE=0.22, IRIS_R=34, BROW_GAP=13),
    # The minimal reference: the black mass is the PUPIL, not the lash. Thin
    # lid stroke, a long taper off both corners, a flat-topped pupil with a
    # notch bitten out of it, and crossed lower lashes.
    # An inner spike eats into the gap between the eyes, so this one budgets
    # its widths differently: 2*100 body + 38 gap + 2*40 outer = 318 of 320,
    # with a 20px inner margin for the spike to live in.
    "M  minimal, big pupil": dict(ANG=0.75, LID_UP=34, LID_LO=12, LO_EDGE=0.14,
                                  UP_APEX=0.44, BODY_W=100, EYE_GAP=38,
                                  MARGIN_IN=20, MARGIN_OUT=40,
                                  IRIS_R=30, IRIS_S=0.47, IRIS_DY=1,
                                  IRIS_FIX=((250,248,252),(250,248,252)),
                                  PUPIL="shield", PUPIL_W=0.78, PUPIL_H=0.92,
                                  PUPIL_FLAT=0.26, HILITE_SHAPE="notch",
                                  HILITE=(0,0,5),
                                  LASH=7.0, LASH_BASE=3, FLICK=40, FLICK_RISE=0.30,
                                  INNER_SPIKE=16, LOWER_CROSS=True,
                                  BROW=False, UNDER=False, LOWER_T=2),

    # M with the tilt from the drawn-over preview: the outer corner rides far
    # above the inner one and the flick carries that line on upward, so the
    # corner is an acute V pointing up and out rather than a flat taper.
    "N  M, lifted outer":    dict(ANG=0.75, LID_UP=42, LID_LO=32, LO_EDGE=0.14,
                                  UP_APEX=0.44, BODY_W=100, EYE_GAP=38,
                                  MARGIN_IN=20, MARGIN_OUT=40, SLANT=0.04, LIFT=40, LIFT_POW=3.4,
                                  IRIS_R=30, IRIS_S=0.44, IRIS_DY=0,
                                  IRIS_FIX=((250,248,252),(250,248,252)),
                                  PUPIL="shield", PUPIL_W=0.76, PUPIL_H=0.78,
                                  PUPIL_FLAT=0.26, HILITE_SHAPE="notch",
                                  HILITE=(0,0,4),
                                  LASH=7.0, LASH_BASE=3, FLICK=38, FLICK_RISE=0.85,
                                  INNER_SPIKE=16, LOWER_CROSS=True,
                                  BROW=False, UNDER=False, LOWER_T=2),

    # M, but with the upper lid as a plateau rather than an arch - flat and
    # high across the eye, turning down only at the corners. Everything below
    # the lid line is M unchanged, including the pupil and its clipping.
    "O  M, flat top lid":    dict(ANG=0.75, LID_UP=36, LID_LO=12,
                                  UP_SHAPE="flat", UP_EDGE_IN=0.30, UP_EDGE_OUT=0.13,
                                  LO_EDGE_IN=0.16, LO_EDGE_OUT=0.10,
                                  BODY_W=100, EYE_GAP=38,
                                  MARGIN_IN=20, MARGIN_OUT=40, SLANT=0.13,
                                  IRIS_R=30, IRIS_S=0.47, IRIS_DY=1,
                                  IRIS_FIX=((250,248,252),(250,248,252)),
                                  PUPIL="shield", PUPIL_W=0.78, PUPIL_H=0.92,
                                  PUPIL_FLAT=0.26, HILITE_SHAPE="notch",
                                  HILITE=(0,0,5),
                                  LASH=7.0, LASH_BASE=3, FLICK=38, FLICK_RISE=0.55,
                                  INNER_SPIKE=16, LOWER_CROSS=True,
                                  BROW=False, UNDER=False, LOWER_T=2),

    "L  fully angular":      dict(ANG=1.0, LID_UP=34, LID_LO=14, UP_APEX=0.38,
                                  SLANT=0.16, LASH=22.0, FLICK=40, FLICK_RISE=0.35,
                                  IRIS_R=28, BROW_T=5.0),
}

THEMES = {"light": ((240,238,246),(255,255,255),(10,8,16),(96,88,112)),
          "dark":  ((6,6,10),(250,248,252),(38,28,60),(124,110,146))}

def bell(s, a, p):
    if s <= 0.0 or s >= 1.0: return 0.0
    # max(0,...) mirrors the guard face.cpp needs: in float, sin() of pi lands
    # just below zero and a fractional power of it is NaN.
    return max(0.0, math.sin(math.pi * (s ** (math.log(0.5)/math.log(a))))) ** p

def tent(s, a):
    """Piecewise-linear peak at `a`: straight edges, hard apex."""
    if s <= 0.0 or s >= 1.0: return 0.0
    return s/a if s < a else (1.0-s)/(1.0-a)

_EASE = 0.0   # set per-variant by eye_sprite before the lids are evaluated

def _ramp(t, ease):
    """Corner ramp. Linear at ease 0, sine-eased at 1.

    A linear ramp meets the plateau at a hard angle and the eye reads as a
    hexagon; easing lands it with zero slope so the corner rounds off."""
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    if ease <= 0.0: return t
    return (1.0-ease)*t + ease*math.sin(t*math.pi*0.5)

def plateau(s, edge_in, edge_out):
    """Flat across the middle, ramping only near the corners.

    Both bell() and tent() peak by construction, so a lid built from either is
    an arch no matter where the apex sits. The references draw a lid that runs
    flat and high across the whole eye and turns down only at the ends, which
    is this. The two ramps are independent: the inner corner usually tapers
    gradually while the outer one turns sharply into the flick."""
    if s <= 0.0 or s >= 1.0: return 0.0
    return _ramp(s/edge_in, _EASE) * _ramp((1.0-s)/edge_out, _EASE)

def lidcurve(s, a, p, ang):
    """Blend the round bell toward the angular tent.

    sin() is round by construction, which is what made every early shape look
    oval no matter how the apex moved. `ang` is the dial that actually
    straightens the lid edges."""
    if ang <= 0.0: return bell(s, a, p)
    if ang >= 1.0: return tent(s, a)
    return (1.0-ang)*bell(s, a, p) + ang*tent(s, a)

def sprite_w(P):
    return P["MARGIN_IN"] + P["BODY_W"] + P["MARGIN_OUT"]

def body_start(P, left):
    # Outer side is left for the left eye, right for the right eye.
    return P["MARGIN_OUT"] if left else P["MARGIN_IN"]

def eye_sprite(P, left, lid, inten, hearts, bg, sclera, ink):
    H,ECY = P["EYE_H"],P["ECY"]
    W = sprite_w(P); BW = P["BODY_W"]; M = body_start(P, left)
    img=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(img)
    outer = -1.0 if left else 1.0
    op = max(0.0, min(1.0, lid - inten*0.34))
    upOpen = int(P["LID_UP"]*op); loOpen = int(P["LID_LO"]*(0.45+0.55*op))
    bcx = M + BW//2

    def S(x):
        u=(x-M)/(BW-1); return (1.0-u) if left else u
    def sl(x): return int(-P["SLANT"]*(x-bcx)*outer) - int(P["LIFT"]*(S(x)**P["LIFT_POW"]))
    A=P["ANG"]
    global _EASE
    _EASE = P["RAMP_EASE"]
    lo_in  = P["LO_EDGE_IN"]  if P["LO_EDGE_IN"]  is not None else P["LO_EDGE"]
    lo_out = P["LO_EDGE_OUT"] if P["LO_EDGE_OUT"] is not None else P["LO_EDGE"]
    def up(s):
        if P["UP_SHAPE"] == "flat":
            return plateau(s, P["UP_EDGE_IN"], P["UP_EDGE_OUT"])
        return lidcurve(s, P["UP_APEX"], P["UP_P"], A)
    def lo(s):
        if P["LO_SHAPE"] == "flat":
            return plateau(s, lo_in, lo_out)
        return lidcurve(s, P["LO_APEX"], P["LO_P"], A)
    def bodyx(s):
        u=(1.0-s) if left else s; return M+int(u*(BW-1))
    def edges(x):
        s=S(x); v=sl(x)
        return s,(ECY+v-int(upOpen*up(s))),(ECY+v+int(loOpen*lo(s)))
    def lash_t(x):
        s=S(x); u=(x-M)/(BW-1)
        # Guarded to match face.cpp: sinf(PI) is slightly NEGATIVE in float,
        # where Python's sin(pi) is slightly positive. Unguarded, the firmware
        # hits NaN here and the simulator does not.
        roundp = max(0.0, math.sin(math.pi*u))**0.45
        angp = min(u, 1.0-u)*2.0
        prof = (1.0-A)*roundp + A*angp
        return P["LASH_BASE"]+int(P["LASH"]*prof*(0.30+0.70*s))

    for x in range(M, M+BW):
        _,yT,yB = edges(x)
        if yB>yT: d.line([(x,yT),(x,yB-1)],fill=sclera)

    if upOpen>8:
        R=P["IRIS_R"]; cx,cy = bodyx(P["IRIS_S"]), ECY+P["IRIS_DY"]
        for dy in range(-R,R+1):
            f=dy/R; hw=int(R*math.sqrt(max(0,1-f*f))); k=(dy+R)/(2*R)
            if P["IRIS_FIX"]:
                t,b = P["IRIS_FIX"]
            else:
                t=(10,34,78) if inten<0.5 else (74,4,48)
                b=(96,190,232) if inten<0.5 else (255,86,156)
            d.line([(cx-hw,cy+dy),(cx+hw,cy+dy)],fill=tuple(int(t[i]+(b[i]-t[i])*k) for i in range(3)))
        if hearts:
            r=int(R*0.66); d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=(14,8,26))
            r=int(R*0.55); l=int(r*0.52); t0=cy-3-l//2
            d.ellipse([cx-2*l,t0-l,cx,t0+l],fill=(255,255,255))
            d.ellipse([cx,t0-l,cx+2*l,t0+l],fill=(255,255,255))
            d.polygon([(cx-2*l,t0),(cx+2*l,t0),(cx,cy-3+r)],fill=(255,255,255))
        else:
            rx,ry=int(R*P["PUPIL_W"]),int(R*P["PUPIL_H"])
            if P["PUPIL"]=="shield":
                # Flat top, straight sides, elliptical bottom.
                flat=P["PUPIL_FLAT"]
                for k in range(2*ry):
                    t=k/(2*ry-1)
                    if t<flat: hw=rx
                    else:
                        q=(t-flat)/(1.0-flat)
                        hw=int(rx*math.sqrt(max(0.0,1.0-q*q)))
                    if hw>0: d.line([(cx-hw,cy-ry+k),(cx+hw,cy-ry+k)],fill=(14,8,26))
            else:
                d.ellipse([cx-rx,cy-ry,cx+rx,cy+ry],fill=(14,8,26))
            hx,hy,hr = P["HILITE"]
            if P["HILITE_SHAPE"]=="notch":
                d.polygon([(cx+hx-hr,cy-ry-1),(cx+hx+hr,cy-ry-1),
                           (cx+hx,cy-ry+hr+1)],fill=(255,255,255))
            else:
                d.ellipse([cx+hx-hr,cy+hy-hr,cx+hx+hr,cy+hy+hr],fill=(255,255,255))

    for x in range(M, M+BW):
        s,yT,yB = edges(x); u=(x-M)/(BW-1)
        if yT>0: d.line([(x,0),(x,yT-1)],fill=bg)
        if yB<H: d.line([(x,yB),(x,H-1)],fill=bg)
        thick = lash_t(x)
        d.line([(x,yT-thick+2),(x,yT+1)],fill=ink)
        if 0.34<s<0.94 and upOpen>12: d.point((x,yT-thick-3),fill=ink)
        if loOpen>5: d.line([(x,yB-1),(x,yB-1+P["LOWER_T"])],fill=ink)
        if P["UNDER"] and 0.14<s<0.86 and loOpen>8:
            d.point((x,yB+6),fill=ink)

    F=P["FLICK"]; RISE=P["FLICK_RISE"]
    for s,ln,half in ((0.99,F,5),(0.82,int(F*0.42),4),(0.66,int(F*0.26),3)):
        bx=bodyx(s); by=ECY+sl(bx)-int(upOpen*up(s))-2; dr=int(outer)
        d.polygon([(bx-half,by),(bx+half,by),
                   (bx+dr*ln,by-int(ln*RISE))],fill=ink)
    if P["INNER_SPIKE"]:
        ln=P["INNER_SPIKE"]; bx=bodyx(0.01); dr=-int(outer)
        by=ECY+sl(bx)-int(upOpen*up(0.01))-1
        d.polygon([(bx,by-3),(bx,by+3),(bx+dr*ln,by+int(ln*0.22))],fill=ink)

    if P["LOWER_CROSS"] and loOpen>6:
        for s in (0.30,0.48,0.66):
            bx=bodyx(s); by=ECY+sl(bx)+int(loOpen*lo(s))
            d.line([(bx-7,by-1),(bx+7,by+11)],fill=ink,width=2)
            d.line([(bx+7,by-1),(bx-7,by+11)],fill=ink,width=2)
    elif loOpen>8:
        for s in (0.34,0.50,0.66):
            bx=bodyx(s); by=ECY+sl(bx)+int(loOpen*lo(s)); dr=int(outer)
            d.polygon([(bx-3,by-2),(bx+3,by-2),(bx-dr*3,by+9)],fill=ink)

    if P["BROW"]:
        for x in range(M, M+BW):
            s=S(x)
            if s<0.10 or s>0.96: continue
            # Sit a fixed gap above where the lash actually ends. ARC < 1
            # flattens the brow relative to the lid.
            lashTop = ECY+sl(x)-int(P["LID_UP"]*up(s)*P["BROW_ARC"]) - lash_t(x)
            base = lashTop - P["BROW_GAP"] - int(P["BROW_TILT"]*s)
            t = 2+int(P["BROW_T"]*((1.0-s)**0.6))
            d.line([(x,base),(x,base+t)],fill=ink)
    return img

def panel(P, theme, lid, inten, hearts, label):
    bg,sclera,ink,muted = THEMES[theme]
    img=Image.new("RGB",(320,168),bg)
    ECY,EYE_CY,GAP,BW = P["ECY"],P["EYE_CY"],P["EYE_GAP"],P["BODY_W"]
    # Place by where the eye BODY lands; the sprites then overlap in their
    # empty inner margins, which is harmless because both are background there.
    for bcx,left in ((160-(BW//2+GAP//2),True),(160+(BW//2+GAP//2),False)):
        x = bcx - BW//2 - body_start(P,left)
        img.paste(eye_sprite(P,left,lid,inten,hearts,bg,sclera,ink),(x,EYE_CY-ECY))
    ImageDraw.Draw(img).text((6,156),label,fill=muted)
    return img

def params(over):
    P=dict(BASE); P.update(over); return P


# ===========================================================================
# Mouth
#
# Same construction as the eyes: an upper and a lower edge evaluated per
# column, meeting at the corners. `open` scales their separation, so a closed
# mouth is the two edges collapsing onto one line rather than a second shape.
# ===========================================================================

MOUTH_BASE = dict(
    # Narrower than one eye. A mouth as wide as the eyes reads as a muzzle;
    # anime keeps it inside the gap between the pupils.
    MW=78, MH=52,               # sprite
    UP_H=13, LO_H=18,           # half-heights at full open
    SMILE=5,                    # corner lift in px; negative frowns
    BOW=4, BOW_W=0.13,          # the cupid's bow notch at the top centre
    ARCH_P=0.85,                # how full the opening is across the width
    LINE_T=3,                   # closed-mouth lip thickness
    FANGS=0, FANG_LEN=7,        # evenly spaced upper fangs, only while open
    # A single snaggletooth, drawn whether the mouth is open or shut - hanging
    # over the lip is the entire point of one. Outlined, or it vanishes against
    # a light background.
    FANG_ONE=None, FANG_ONE_LEN=9, FANG_ONE_W=5,
    FILL=None,                  # interior; defaults to ink
    TONGUE=False, TONGUE_AT=0.45,
    INK=None, TONGUE_RGB=(226,96,120),
)

MOUTHS = {
    # A solid black opening reads as a hole; the painted references outline in
    # dark and fill lighter, so anything without fangs gets a maroon interior.
    "simple":  dict(FILL=(72,26,34)),
    "open":    dict(TONGUE=True, FILL=(72,26,34)),
    "fangs":   dict(FANGS=3, TONGUE=True, SMILE=8, LO_H=21),
    # Centre raised (negative BOW) with the corners dropped: the omega shape.
    # UP_H=0 pins the upper lip: the omega stays put and the mouth opens
    # downward from it. Letting it rise too makes an opening mouth read as a
    # mound growing out of the face.
    "cat":     dict(SMILE=-3, BOW=-7, BOW_W=0.26, UP_H=0, LO_H=17,
                    FILL=(72,26,34), FANG_ONE=0.76),
}

def _arch(u, p):
    if u <= 0.0 or u >= 1.0: return 0.0
    return math.sin(math.pi*u)**p

def mouth_sprite(P, amount, bg, ink, sclera):
    """amount 0 = closed line, 1 = wide open."""
    MW, MH = P["MW"], P["MH"]
    img = Image.new("RGB", (MW, MH), bg); d = ImageDraw.Draw(img)
    cy = MH//2
    amount = max(0.0, min(1.0, amount))

    def base(u):
        # Corners ride above the centre for a smile, below it for a frown.
        return cy - P["SMILE"] * (abs(u-0.5)*2.0)**1.5

    def bow(u):
        # A small notch pushing the upper lip DOWN at the centre.
        t = abs(u-0.5)/P["BOW_W"]
        return P["BOW"] * max(0.0, 1.0-t)

    def edges(x):
        u = x/(MW-1); b = base(u); a = _arch(u, P["ARCH_P"])
        return (b - amount*P["UP_H"]*a + bow(u),
                b + amount*P["LO_H"]*a)

    # Interior.
    fill = P["FILL"] or ink
    for x in range(MW):
        yT, yB = edges(x)
        if yB - yT >= 1:
            d.line([(x, int(yT)), (x, int(yB))], fill=fill)

    # Tongue: sits in the bottom of the opening, never touching the lip line.
    if P["TONGUE"] and amount > P["TONGUE_AT"]:
        for x in range(MW):
            yT, yB = edges(x)
            if yB - yT < 8: continue
            top = yB - (yB-yT)*0.42
            if yB-2 > top:
                d.line([(x, int(top)), (x, int(yB)-2)], fill=P["TONGUE_RGB"])

    # Fangs hang from the upper edge; the lower ones point back up at half
    # length, which is what reads as a fanged mouth rather than a saw.
    if P["FANGS"] and amount > 0.2:
        n = P["FANGS"]
        for i in range(n):
            u = (i+0.5)/n
            x = int(u*(MW-1)); yT, yB = edges(x)
            ln = min(P["FANG_LEN"], (yB-yT)*0.55)
            d.polygon([(x-5, yT-1), (x+5, yT-1), (x, yT+ln)], fill=sclera)
        for i in range(n-1):
            u = (i+1.0)/n
            x = int(u*(MW-1)); yT, yB = edges(x)
            ln = min(P["FANG_LEN"]*0.5, (yB-yT)*0.35)
            d.polygon([(x-4, yB+1), (x+4, yB+1), (x, yB-ln)], fill=sclera)

    # The lip line, always: it is the whole mouth when closed.
    for x in range(MW):
        yT, _ = edges(x)
        d.line([(x, int(yT)-P["LINE_T"]+1), (x, int(yT))], fill=ink)

    if P["FANG_ONE"] is not None:
        fx = int(P["FANG_ONE"]*(MW-1))
        top = edges(fx)[0]
        w, ln = P["FANG_ONE_W"], P["FANG_ONE_LEN"]
        # Rotate to the lip. Hanging straight down leaves the fang leaning away
        # from a lip that is sloping underneath it; its base should lie along
        # the lip and its tip along the lip's normal.
        step = 3
        a = edges(max(0, fx-step))[0]
        b = edges(min(MW-1, fx+step))[0]
        m = (b-a) / (2.0*step)
        norm = math.hypot(1.0, m)
        ux, uy = 1.0/norm, m/norm          # along the lip
        nx, ny = -m/norm, 1.0/norm         # its normal, pointing down
        def pt(along, down, shrink=0.0):
            return (fx + along*ux + down*nx, top + along*uy + down*ny - shrink)
        d.polygon([pt(-w, -1), pt(w, -1), pt(0, ln)], fill=ink)
        d.polygon([pt(-w+2, 0), pt(w-2, 0), pt(0, ln-3)], fill=sclera)
    return img

def nose_dash(img, cx, cy, ink):
    """Anime nose: a dash. Two pixels of angle is the whole thing."""
    d = ImageDraw.Draw(img)
    d.line([(cx-5, cy), (cx+1, cy+3)], fill=ink, width=2)

def face_panel(eyeP, mouthP, theme, lid, inten, hearts, amount, label, bangsP=None):
    bg, sclera, ink, muted = THEMES[theme]
    img = Image.new("RGB", (320, 240), bg)
    ECY, EYE_CY, GAP, BW = eyeP["ECY"], eyeP["EYE_CY"], eyeP["EYE_GAP"], eyeP["BODY_W"]
    for bcx, left in ((160-(BW//2+GAP//2), True), (160+(BW//2+GAP//2), False)):
        x = bcx - BW//2 - body_start(eyeP, left)
        img.paste(eye_sprite(eyeP, left, lid, inten, hearts, bg, sclera, ink),
                  (x, EYE_CY-ECY))
    # After the eyes: the eye sprite's empty top rows would paint over the
    # fringe, and hair hangs in front of the forehead in any case.
    if bangsP:
        draw_bangs(img, bangsP, ink, bg)
    nose_dash(img, 160, 154, ink)
    m = mouth_sprite(mouthP, amount, bg, ink, sclera)
    # 170 is just inside the control bar's strip, which is empty whenever the
    # bar is hidden - which is nearly always.
    img.paste(m, (160-mouthP["MW"]//2, 170))
    ImageDraw.Draw(img).text((6, 228), label, fill=muted)
    return img


# ===========================================================================
# Bangs
#
# Just the fringe, not a head of hair: a mass filled from the top of the panel
# down to a per-column edge. The style is entirely in that edge - how many
# strands, how deep they hang, how uneven they are, and how far the locks at
# the sides come down past the rest.
# ===========================================================================

BANGS_BASE = dict(
    BASE=34,        # where the fringe starts before any lock hangs from it
    SEAM=True,      # thin gaps between locks, so it reads as strands
    HAIR=None,      # None = the same ink as the lashes
)

# Each lock is (centre, half width, length), and the fringe is their UNION.
# A single per-column sawtooth reads as a cartoon crown; overlapping tapered
# locks sweeping out from a parting is what actual bangs are.
BANGS = {
    "4 bob":   dict(BASE=30, LOCKS=[(0.50,0.15,30),(0.34,0.16,42),(0.66,0.16,42),
                                    (0.20,0.14,54),(0.80,0.14,54),
                                    (0.02,0.10,96),(0.98,0.10,96)]),
    "5 wolf":  dict(BASE=26, LOCKS=[(0.50,0.12,26),(0.38,0.12,46),(0.62,0.13,38),
                                    (0.26,0.13,62),(0.74,0.12,52),
                                    (0.12,0.13,84),(0.88,0.13,92),
                                    (0.01,0.09,112),(0.99,0.09,104)]),
    "6 blunt": dict(BASE=52, LOCKS=[(0.50,0.46,10),(0.30,0.20,14),(0.70,0.20,14),
                                    (0.03,0.11,130),(0.97,0.11,130)]),
}

def bang_edge(u, P):
    y = P["BASE"]
    for c, w, ln in P["LOCKS"]:
        d = abs(u - c) / w
        if d < 1.0:
            y = max(y, P["BASE"] + ln * (1.0 - d*d))
    return y

def draw_bangs(img, P, ink, bg):
    d = ImageDraw.Draw(img)
    W = img.width
    hair = P["HAIR"] or ink
    for x in range(W):
        u = x/(W-1)
        d.line([(x, 0), (x, int(bang_edge(u, P)))], fill=hair)

    # Strand seams run DOWN from the crown to the hairline, the way a parting
    # does. Tracing each lock's outline instead scallops the edge like lace.
    if P["SEAM"]:
        for c, w, ln in P["LOCKS"]:
            for side in (-1, 1):
                uu = c + side*w*0.94
                if not 0.0 <= uu <= 1.0:
                    continue
                x = int(uu*(W-1))
                d.line([(x, 0), (x, int(bang_edge(uu, P))-1)], fill=bg)


if len(sys.argv)>1 and sys.argv[1]=="bangs":
    eyeP=params(VARIANTS["M  minimal, big pupil"]); eyeP["EYE_CY"]=118
    mp=dict(MOUTH_BASE); mp.update(MOUTHS["cat"])
    names=list(BANGS)
    out=Image.new("RGB",(320*len(names),240*2))
    for i,n in enumerate(names):
        bp=dict(BANGS_BASE); bp.update(BANGS[n])
        out.paste(face_panel(eyeP,mp,"light",1.0,0.0,False,0.0,n,bp),(320*i,0))
        out.paste(face_panel(eyeP,mp,"dark", 1.0,0.85,True,0.9,n,bp),(320*i,240))
    out.save("_preview.png"); print("wrote _preview.png", out.size)
    sys.exit(0)

if len(sys.argv)>1 and sys.argv[1]=="face":
    eyeP=params(VARIANTS["M  minimal, big pupil"])
    eyeP["EYE_CY"] = 116          # drop the eyes to close the gap to the mouth
    shots=[]
    for name in ("simple","open","fangs","cat"):
        mp=dict(MOUTH_BASE); mp.update(MOUTHS[name])
        shots.append((f"{name}  idle", mp, 1.0, 0.0, False, 0.0))
        shots.append((f"{name}  mid",  mp, 1.0, 0.5, False, 0.55))
        shots.append((f"{name}  peak", mp, 1.0, 0.9, True,  1.0))
    cols=3
    out=Image.new("RGB",(320*cols,240*((len(shots)+cols-1)//cols)))
    for i,(lbl,mp,lid,inten,h,amt) in enumerate(shots):
        out.paste(face_panel(eyeP,mp,"light",lid,inten,h,amt,lbl),
                  (320*(i%cols),240*(i//cols)))
    out.save("_preview.png")
    print("wrote _preview.png", out.size)
    sys.exit(0)

if len(sys.argv)>1:
    key=[k for k in VARIANTS if k.startswith(sys.argv[1])][0]
    P=params(VARIANTS[key])
    rows=[(t,n,l,i,h) for t in THEMES for n,l,i,h in
          [("open",1.0,0.0,False),("half/hot+hearts",1.0,0.75,True),("blink",0.3,0.0,False)]]
    out=Image.new("RGB",(320,168*len(rows)))
    for r,(t,n,l,i,h) in enumerate(rows):
        out.paste(panel(P,t,l,i,h,f"{key}  -  {t} / {n}"),(0,168*r))
else:
    # Every variant, two per row, so shapes can be compared at a glance.
    show=list(VARIANTS.items())
    cols=2; rowsN=(len(show)+cols-1)//cols
    out=Image.new("RGB",(320*cols,168*rowsN),(40,38,48))
    for i,(name,over) in enumerate(show):
        out.paste(panel(params(over),"light",1.0,0.0,False,name),
                  (320*(i%cols),168*(i//cols)))
out.resize((out.width*2,out.height*2),Image.NEAREST).save("_preview.png")
print("wrote _preview.png")
