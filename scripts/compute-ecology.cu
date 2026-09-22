// CUDA port for measurement only. Compile with --fmad=false and no fast math.
__device__ double bounded(double x) { return x<0?0:(x>1?1:x); }
__device__ double unit(unsigned int seed, int x, int y) {
  unsigned int v=seed ^ 1400u ^ ((unsigned int)x*0x9e3779b1u) ^ ((unsigned int)y*0x85ebca77u);
  v=(v^(v>>16))*0x7feb352du;
  v=(v^(v>>15))*0x846ca68bu;
  return (v^(v>>16))/4294967296.0;
}
__device__ double fade(double t) { return t*t*t*(t*(t*6-15)+10); }
__device__ double lerp(double a,double b,double t) { return a+(b-a)*t; }
__device__ double basinNoise(unsigned int seed,double x,double y) {
  double px=x/24,py=y/24;
  int ix=(int)floor(px),iy=(int)floor(py);
  double tx=fade(px-ix),ty=fade(py-iy);
  return lerp(lerp(unit(seed,ix,iy),unit(seed,ix+1,iy),tx),lerp(unit(seed,ix,iy+1),unit(seed,ix+1,iy+1),tx),ty);
}
extern "C" __global__ void ecology(const double* in, double* out, const int* neighbors,
  int n, int tick, int rain, double light, int begin, int end, double decay, unsigned int seed, double basins) {
  int i=begin+blockIdx.x*blockDim.x+threadIdx.x;
  if(i>=end) return;
  int local=i-begin, count=end-begin;
  #define O(f) out[(f)*count+local]
  for(int f=0;f<17;f++) O(f)=in[f*n+i];
  if(tick%10) return;
  double growth=in[i],fertility=in[n+i],life=in[2*n+i],moisture=in[3*n+i];
  double water=in[4*n+i],cultivation=in[5*n+i],traffic=in[6*n+i];
  double vegetation=in[7*n+i],wood=in[8*n+i];
  int feature=(int)in[9*n+i],aquatic=(int)in[10*n+i],ocean=(int)in[11*n+i];
  int mountain=(int)in[12*n+i],wetland=(int)in[13*n+i];
  int living=0;
  for(int k=0;k<8;k++) { int q=neighbors[i*8+k]; if(q>=0 && in[2*n+q]>=0.45) living++; }
  bool fertilePattern=living==3 || (life>=0.45 && living==2);
  double cellularEnergy=light*moisture*(0.6+fertility*0.4);
  O(2)=bounded(life+((fertilePattern?1:0)-life)*0.2*cellularEnergy-(moisture<0.15?0.015:0)-traffic*0.004);
  O(1)=bounded(fertility+life*0.0012-traffic*0.0007-cultivation*0.0002-decay*fertility);
  double produced=light*moisture*fertility*(0.25+life*0.75)*(1-growth)*(1-traffic*0.9)*0.005;
  O(0)=bounded(growth+produced-0.0002-traffic*0.002-(moisture<0.15?0.001:0));
  if(!aquatic) O(7)=bounded(vegetation+produced*0.25-traffic*0.001);
  O(6)=bounded(traffic-0.0005); O(5)=bounded(cultivation-0.00002);
  bool reservoir=(feature==9 || feature==8 || wetland || aquatic) && (aquatic || basinNoise(seed,in[15*n+i],in[16*n+i])<basins);
  O(4)=ocean?0:bounded(water+(reservoir&&rain?0.008*(0.4+fertility*0.6):0)+(reservoir&&feature==8?0.002:0)-(light?0.00015:0.00003));
  if(aquatic) O(3)=bounded(moisture+(ocean?0.003:0)+(rain?0.008:0));
  if(tick%100==0 && feature>=2 && feature<=7 && growth>0.65 && fertility>0.4 && moisture>0.35 && traffic<0.35 && light>0) {
    double capacity=feature==6||feature==5?2:feature==4?6:12;
    double available=capacity-wood,producedWood=0.025*light*moisture*fertility;
    double regrowth=available<producedWood?available:producedWood;
    if(regrowth>0) {
      O(8)=wood+regrowth; O(14)=1;
      O(0)=bounded(O(0)-regrowth*0.05);
      if(feature==7 && O(8)>=1) O(9)=mountain?3:2;
    }
  }
}
