"""Preview of drawEye() on the host. Mirrors face.cpp constant for constant,
including drawing into a sprite-sized buffer so clipping shows up here too."""
import math
from PIL import Image, ImageDraw

EYE_W=EYE_H=116; ECY=70; EYE_CY=90; EYE_GAP=26
LID_UP=47; LID_LO=34; IRIS_R=29; SLANT=0.13
THEMES={"light":((240,238,246),(255,255,255),(10,8,16),(96,88,112)),
        "dark": ((6,6,10),(250,248,252),(38,28,60),(124,110,146))}

def upper(u): return math.sin(math.pi*u)**0.70
def lower(u): return math.sin(math.pi*u)**1.30

def eye_sprite(left, lid, inten, hearts, bg, sclera, ink):
    img=Image.new("RGB",(EYE_W,EYE_H),bg); d=ImageDraw.Draw(img)
    scx=EYE_W//2; outer=-1.0 if left else 1.0
    op=max(0.0,min(1.0, lid - inten*0.34))
    upOpen=int(LID_UP*op); loOpen=int(LID_LO*(0.45+0.55*op))
    sl=lambda dx:int(-SLANT*dx*outer)
    def edges(x):
        u=x/(EYE_W-1); s=sl(x-scx)
        return u,(ECY+s-int(upOpen*upper(u))),(ECY+s+int(loOpen*lower(u)))

    for x in range(EYE_W):
        _,yT,yB=edges(x)
        if yB>yT: d.line([(x,yT),(x,yB-1)],fill=sclera)
    if upOpen>8:
        cx,cy=scx,ECY
        for dy in range(-IRIS_R,IRIS_R+1):
            f=dy/IRIS_R; hw=int(IRIS_R*math.sqrt(max(0,1-f*f)))
            k=(dy+IRIS_R)/(2*IRIS_R)
            top=(10,34,78) if inten<0.5 else (74,4,48); bot=(96,190,232) if inten<0.5 else (255,86,156)
            c=tuple(int(top[i]+(bot[i]-top[i])*k) for i in range(3))
            d.line([(cx-hw,cy+dy),(cx+hw,cy+dy)],fill=c)
        r=int(IRIS_R*0.66) if hearts else int(IRIS_R*0.42)
        d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=(14,8,26))
        if hearts:
            hy=cy-3; R=int(IRIS_R*0.55); lo=int(R*0.52); t=hy-lo//2
            d.ellipse([cx-lo-lo,t-lo,cx-lo+lo,t+lo],fill=(255,255,255))
            d.ellipse([cx+lo-lo,t-lo,cx+lo+lo,t+lo],fill=(255,255,255))
            d.polygon([(cx-2*lo,t),(cx+2*lo,t),(cx,hy+R)],fill=(255,255,255))
        else:
            d.ellipse([cx-11-8,cy-12-8,cx-11+8,cy-12+8],fill=(255,255,255))

    for x in range(EYE_W):
        u,yT,yB=edges(x)
        if yT>0: d.line([(x,0),(x,yT-1)],fill=bg)
        if yB<EYE_H: d.line([(x,yB),(x,EYE_H-1)],fill=bg)
        outerness=(1.0-u) if left else u
        thick=6+int(17.0*(math.sin(math.pi*u)**0.50)*(0.38+0.62*outerness))
        d.line([(x,yT-thick+2),(x,yT+1)],fill=ink)
        if 0.12<u<0.88 and upOpen>14: d.point((x,yT-thick-3),fill=ink)
        if loOpen>6: d.line([(x,yB-2),(x,yB+1)],fill=ink)

    for i in range(6):
        u=0.10+i*0.16; outerness=(1.0-u) if left else u
        bx=int(u*(EYE_W-1)); by=ECY+sl(bx-scx)-int(upOpen*upper(u))-2
        ln=10+int(21.0*outerness); dr=int(outer)
        d.polygon([(bx-3,by),(bx+3,by),(bx+dr*int(ln*0.62),by-ln)],fill=ink)
    if loOpen>10:
        for i in range(5):
            u=0.22+i*0.14; bx=int(u*(EYE_W-1))
            by=ECY+sl(bx-scx)+int(loOpen*lower(u)); dr=int(outer)
            d.polygon([(bx-3,by-2),(bx+3,by-2),(bx-dr*3,by+10)],fill=ink)
    return img

rows=[(t,n,l,i,h) for t in THEMES for n,l,i,h in
      [("open",1.0,0.0,False),("half / hot + hearts",1.0,0.75,True),("blink",0.3,0.0,False)]]
out=Image.new("RGB",(320,168*len(rows)))
for r,(theme,name,lid,inten,h) in enumerate(rows):
    bg,sclera,ink,muted=THEMES[theme]; top=168*r
    ImageDraw.Draw(out).rectangle([0,top,319,top+167],fill=bg)
    for cx,left in ((160-(EYE_W//2+EYE_GAP//2),True),(160+(EYE_W//2+EYE_GAP//2),False)):
        out.paste(eye_sprite(left,lid,inten,h,bg,sclera,ink),(cx-EYE_W//2,top+EYE_CY-ECY))
    ImageDraw.Draw(out).text((6,top+154),theme+" / "+name,fill=muted)
out.resize((640,168*len(rows)*2),Image.NEAREST).save("_preview.png")
print("wrote _preview.png")
