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
    SLANT=0.13, LIFT=0,
    ANG=0.60, LO_SHAPE="flat", LO_EDGE=0.20,
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
    "N  M, lifted outer":    dict(ANG=0.75, LID_UP=34, LID_LO=20, LO_EDGE=0.14,
                                  UP_APEX=0.44, BODY_W=100, EYE_GAP=38,
                                  MARGIN_IN=20, MARGIN_OUT=40, SLANT=0.10, LIFT=34,
                                  IRIS_R=30, IRIS_S=0.47, IRIS_DY=1,
                                  IRIS_FIX=((250,248,252),(250,248,252)),
                                  PUPIL="shield", PUPIL_W=0.74, PUPIL_H=0.80,
                                  PUPIL_FLAT=0.26, HILITE_SHAPE="notch",
                                  HILITE=(0,0,4),
                                  LASH=7.0, LASH_BASE=3, FLICK=38, FLICK_RISE=0.85,
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
    return math.sin(math.pi * (s ** (math.log(0.5)/math.log(a)))) ** p

def tent(s, a):
    """Piecewise-linear peak at `a`: straight edges, hard apex."""
    if s <= 0.0 or s >= 1.0: return 0.0
    return s/a if s < a else (1.0-s)/(1.0-a)

def trapezoid(s, edge):
    """Flat across the middle, ramping only near the corners.

    The lower lid in the references is a near-straight line. A peaked curve
    there - however angular - makes the eye read as a diamond."""
    if s <= 0.0 or s >= 1.0: return 0.0
    return min(1.0, s/edge) * min(1.0, (1.0-s)/edge)

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
    def sl(x): return int(-P["SLANT"]*(x-bcx)*outer) - int(P["LIFT"]*S(x))
    A=P["ANG"]
    def up(s): return lidcurve(s, P["UP_APEX"], P["UP_P"], A)
    def lo(s):
        if P["LO_SHAPE"] == "flat":
            return trapezoid(s, P["LO_EDGE"])
        return lidcurve(s, P["LO_APEX"], P["LO_P"], A)
    def bodyx(s):
        u=(1.0-s) if left else s; return M+int(u*(BW-1))
    def edges(x):
        s=S(x); v=sl(x)
        return s,(ECY+v-int(upOpen*up(s))),(ECY+v+int(loOpen*lo(s)))
    def lash_t(x):
        s=S(x); u=(x-M)/(BW-1)
        roundp = math.sin(math.pi*u)**0.45
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
