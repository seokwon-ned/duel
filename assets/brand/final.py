from PIL import Image, ImageDraw, ImageFont, ImageFilter
O=(255,122,26); B=(47,107,255); N=(15,23,42); T=(255,236,140)
G="/usr/share/fonts/truetype/sand-box/google/"
# icon
S=1024
icon=Image.new("RGBA",(S,S),(0,0,0,0))
m=Image.new("L",(S,S),0); ImageDraw.Draw(m).rounded_rectangle([0,0,S-1,S-1],radius=220,fill=255)
icon.paste(Image.new("RGBA",(S,S),N+(255,)),(0,0),m); d=ImageDraw.Draw(icon)
grid=["OOOB","OOBB","OOBB","OBBB"]; pad=150; gap=22; cs=(S-2*pad-3*gap)//4
cell=lambda r,c:(pad+c*(cs+gap),pad+r*(cs+gap))
for r in range(4):
  for c in range(4):
    x,y=cell(r,c); d.rounded_rectangle([x,y,x+cs,y+cs],radius=28,fill=O if grid[r][c]=="O" else B)
ctr=lambda r,c:(cell(r,c)[0]+cs//2,cell(r,c)[1]+cs//2)
pts=[ctr(1,0),ctr(1,2),ctr(3,2)]
g=Image.new("RGBA",(S,S),(0,0,0,0)); ImageDraw.Draw(g).line(pts,fill=T+(200,),width=54)
icon=Image.alpha_composite(icon,g.filter(ImageFilter.GaussianBlur(18))); d=ImageDraw.Draw(icon)
d.line(pts,fill=(255,250,220),width=26); hx,hy=pts[-1]
d.rounded_rectangle([hx-40,hy-40,hx+40,hy+40],radius=14,fill=(255,250,220))
icon.save("icon_1024.png")
for s in (512,192,48): icon.resize((s,s),Image.LANCZOS).save(f"icon_{s}.png")
# logo B
def logo(bg):
  W,H=1600,820
  im=Image.new("RGBA",(W,H),(N+(255,)) if bg else (0,0,0,0)); d=ImageDraw.Draw(im)
  fk=ImageFont.truetype(G+"Black Han Sans/BlackHanSans-Regular.ttf",300)
  b1=d.textbbox((0,0),"땅",font=fk); b2=d.textbbox((0,0),"따",font=fk)
  w1=b1[2]-b1[0]; w2=b2[2]-b2[0]; sp=20; x=(W-(w1+sp+w2))//2; y=60
  d.text((x-b1[0],y),"땅",font=fk,fill=O); d.text((x+w1+sp-b2[0],y),"따",font=fk,fill=B)
  pf=ImageFont.truetype(G+"Press Start 2P/PressStart2P-Regular.ttf",8)
  cellp=17; gp=3
  def tiles(text,color,ox,oy):
    mm=Image.new("L",(9*len(text),8),0); md=ImageDraw.Draw(mm); xx=0
    for ch in text: md.text((xx,0),ch,font=pf,fill=255); xx+=9
    px=mm.load()
    for j in range(8):
      for i in range(mm.width):
        if px[i,j]>128:
          X=ox+i*(cellp+gp); Y=oy+j*(cellp+gp); d.rounded_rectangle([X,Y,X+cellp,Y+cellp],radius=4,fill=color)
  wT=(9*4-1)*(cellp+gp); spc=70; tot=wT*2+spc; ox=(W-tot)//2; oy=470
  tiles("TURF",O,ox,oy); tiles("DUEL",B,ox+wT+spc,oy)
  y0=oy+8*(cellp+gp)+26; xe=ox+tot
  d.line([(ox,y0),(xe-20,y0)],fill=T,width=9)
  d.rounded_rectangle([xe-34,y0-16,xe-2,y0+16],radius=6,fill=T)
  return im
logo(True).convert("RGB").save("logo_final.png")
logo(False).save("logo_final_transparent.png")
print("ok")
