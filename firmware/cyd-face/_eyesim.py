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
    EYE_W=148, EYE_H=138, ECY=98, MARGIN=12, EYE_CY=100, EYE_GAP=6,
    LID_UP=32, LID_LO=22, IRIS_R=32, SLANT=0.13,
    # UP_P well below 1 flattens the bell into a near-straight lid, which is
    # what the reference strokes actually are.
    UP_APEX=0.42, UP_P=0.38, LO_APEX=0.44, LO_P=0.80,
    LASH=20.0, LASH_BASE=6, FLICK=44, FLICK_RISE=0.42,
    BROW=True, BROW_GAP=18, BROW_T=9.0, BROW_ARC=1.0, BROW_TILT=10,
    UNDER=True, LOWER_T=2,
    IRIS_S=0.46, IRIS_DY=0,
)

# Nothing is ever deleted from here: every shape that has been previewed stays
# available, so `python _eyesim.py <letter>` can bring any of them back.
VARIANTS = {
    # -- tall almond / wing, the first pass -------------------------------
    "A  wing, balanced":    dict(EYE_W=136, ECY=94, EYE_CY=98, EYE_GAP=8,
                                 LID_UP=47, LID_LO=22, IRIS_R=29, SLANT=0.10,
                                 UP_APEX=0.36, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=34, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5),
    "B  wing, sharper":     dict(EYE_W=136, ECY=94, EYE_CY=98, EYE_GAP=8,
                                 LID_UP=42, LID_LO=18, IRIS_R=29, SLANT=0.17,
                                 UP_APEX=0.32, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=42, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5),
    "C  wing, rounder":     dict(EYE_W=136, ECY=94, EYE_CY=98, EYE_GAP=8,
                                 LID_UP=51, LID_LO=29, IRIS_R=29, SLANT=0.07,
                                 UP_APEX=0.43, UP_P=0.78, LO_APEX=0.38, LO_P=0.95,
                                 LASH=16.0, LASH_BASE=5, FLICK=26, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5),
    "F  wing, tareme":      dict(EYE_W=136, ECY=94, EYE_CY=98, EYE_GAP=8,
                                 LID_UP=47, LID_LO=27, IRIS_R=29, SLANT=-0.06,
                                 UP_APEX=0.52, UP_P=0.78, LO_APEX=0.52, LO_P=0.95,
                                 LASH=13.0, LASH_BASE=5, FLICK=20, FLICK_RISE=0.75,
                                 BROW_GAP=16, BROW_T=7.0, BROW_ARC=1.0, BROW_TILT=14,
                                 UNDER=False, LOWER_T=3, IRIS_S=0.44, IRIS_DY=-5),

    # -- flat slot, from the heart sheet ----------------------------------
    "G  flat slot":          {},
    "H  flatter, heavier":   dict(LID_UP=27, LID_LO=19, LASH=27.0, LASH_BASE=8,
                                  FLICK=52, FLICK_RISE=0.30, IRIS_R=33),
    "I  sharp, small iris":  dict(LID_UP=35, LID_LO=21, UP_APEX=0.34, UP_P=0.52,
                                  SLANT=0.20, IRIS_R=25, FLICK=50, FLICK_RISE=0.55,
                                  LASH=17.0, BROW_GAP=11, BROW_T=5.0),
    "J  extreme lash mass":  dict(LID_UP=24, LID_LO=17, LASH=34.0, LASH_BASE=10,
                                  FLICK=58, FLICK_RISE=0.22, IRIS_R=34, BROW_GAP=13),
}

THEMES = {"light": ((240,238,246),(255,255,255),(10,8,16),(96,88,112)),
          "dark":  ((6,6,10),(250,248,252),(38,28,60),(124,110,146))}

def bell(s, a, p):
    if s <= 0.0 or s >= 1.0: return 0.0
    return math.sin(math.pi * (s ** (math.log(0.5)/math.log(a)))) ** p

def eye_sprite(P, left, lid, inten, hearts, bg, sclera, ink):
    W,H,ECY,M = P["EYE_W"],P["EYE_H"],P["ECY"],P["MARGIN"]
    BW = W - 2*M
    img=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(img)
    outer = -1.0 if left else 1.0
    op = max(0.0, min(1.0, lid - inten*0.34))
    upOpen = int(P["LID_UP"]*op); loOpen = int(P["LID_LO"]*(0.45+0.55*op))
    bcx = M + BW//2

    def S(x):
        u=(x-M)/(BW-1); return (1.0-u) if left else u
    def sl(x): return int(-P["SLANT"]*(x-bcx)*outer)
    def up(s): return bell(s, P["UP_APEX"], P["UP_P"])
    def lo(s): return bell(s, P["LO_APEX"], P["LO_P"])
    def bodyx(s):
        u=(1.0-s) if left else s; return M+int(u*(BW-1))
    def edges(x):
        s=S(x); v=sl(x)
        return s,(ECY+v-int(upOpen*up(s))),(ECY+v+int(loOpen*lo(s)))
    def lash_t(x):
        s=S(x); u=(x-M)/(BW-1)
        return P["LASH_BASE"]+int(P["LASH"]*(math.sin(math.pi*u)**0.45)*(0.30+0.70*s))

    for x in range(M, M+BW):
        _,yT,yB = edges(x)
        if yB>yT: d.line([(x,yT),(x,yB-1)],fill=sclera)

    if upOpen>8:
        R=P["IRIS_R"]; cx,cy = bodyx(P["IRIS_S"]), ECY+P["IRIS_DY"]
        for dy in range(-R,R+1):
            f=dy/R; hw=int(R*math.sqrt(max(0,1-f*f))); k=(dy+R)/(2*R)
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
            rx,ry=int(R*0.34),int(R*0.56)
            d.ellipse([cx-rx,cy-ry,cx+rx,cy+ry],fill=(14,8,26))
            d.ellipse([cx-13-8,cy-13-8,cx-13+8,cy-13+8],fill=(255,255,255))

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
    if loOpen>8:
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
    W,ECY,EYE_CY,GAP = P["EYE_W"],P["ECY"],P["EYE_CY"],P["EYE_GAP"]
    for cx,left in ((160-(W//2+GAP//2),True),(160+(W//2+GAP//2),False)):
        img.paste(eye_sprite(P,left,lid,inten,hearts,bg,sclera,ink),(cx-W//2,EYE_CY-ECY))
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
    show=[(n,o) for n,o in VARIANTS.items() if n[0] in "GHIJ"]
    out=Image.new("RGB",(320,168*len(show)))
    for r,(name,over) in enumerate(show):
        out.paste(panel(params(over),"light",1.0,0.0,False,name),(0,168*r))
out.resize((640,out.height*2),Image.NEAREST).save("_preview.png")
print("wrote _preview.png")
