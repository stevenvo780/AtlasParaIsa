// Resident GPU ecology kernels over TileStore page layout (T122).
// Compile once with NVRTC: --std=c++11 (FMA allowed since V23: the GPU world is not replayed on the CPU). FP64 only.
// cell = slot*256 + (ly<<4)|lx ; slot=cell>>>8 in JS == cell>>8 here (cell>=0)
__device__ double bounded(double x){ return x<0?0:(x>1?1:x); }
__device__ double unitHash(unsigned int seed,int x,int y){
  unsigned int v=seed ^ 1400u ^ ((unsigned int)x*0x9e3779b1u) ^ ((unsigned int)y*0x85ebca77u);
  v=(v^(v>>16))*0x7feb352du;
  v=(v^(v>>15))*0x846ca68bu;
  return (double)(v^(v>>16))/4294967296.0;
}
__device__ double fadeFn(double t){ return t*t*t*(t*(t*6-15)+10); }
__device__ double lerpFn(double a,double b,double t){ return a+(b-a)*t; }
__device__ double basinNoiseFn(unsigned int seed,double x,double y){
  double px=x/24.0, py=y/24.0;
  int ix=(int)floor(px), iy=(int)floor(py);
  double tx=fadeFn(px-(double)ix), ty=fadeFn(py-(double)iy);
  return lerpFn(lerpFn(unitHash(seed,ix,iy),unitHash(seed,ix+1,iy),tx),lerpFn(unitHash(seed,ix,iy+1),unitHash(seed,ix+1,iy+1),tx),ty);
}
__device__ int neighborCell(const int* around,const unsigned int* stamps,int cell,int dx,int dy,unsigned int version,int* present){
  int slot=cell>>8; int lx=(cell&15)+dx; int ly=((cell>>4)&15)+dy;
  int target=around[slot*9 + (ly<0?0:(ly>15?6:3)) + (lx<0?0:(lx>15?2:1))];
  if(target<0){ *present=0; return -1; }
  int n=(target<<8)|((ly&15)<<4)|(lx&15);
  *present = (stamps[n]==version)?1:0;
  return n;
}
extern "C" __global__ void copy_front_to_back(
  const int* cells,
  const double* moistureF,const double* vegetationF,const double* foodF,const double* woodF,const double* growthF,const double* fertilityF,const double* cultivationF,const double* trafficF,const double* drinkingF,const unsigned char* terrainF,const unsigned char* biomeF,const unsigned char* featureF,const double* lifeF,
  double* moistureB,double* vegetationB,double* foodB,double* woodB,double* growthB,double* fertilityB,double* cultivationB,double* trafficB,double* drinkingB,unsigned char* terrainB,unsigned char* biomeB,unsigned char* featureB,double* lifeB,
  int begin,int end){
  int i=begin+(int)(blockIdx.x*blockDim.x+threadIdx.x); if(i>=end) return; int cell=cells[i];
  moistureB[cell]=moistureF[cell]; vegetationB[cell]=vegetationF[cell]; foodB[cell]=foodF[cell]; woodB[cell]=woodF[cell]; growthB[cell]=growthF[cell]; fertilityB[cell]=fertilityF[cell]; cultivationB[cell]=cultivationF[cell]; trafficB[cell]=trafficF[cell]; drinkingB[cell]=drinkingF[cell]; lifeB[cell]=lifeF[cell]; terrainB[cell]=terrainF[cell]; biomeB[cell]=biomeF[cell]; featureB[cell]=featureF[cell];
}
// Field order: 0 moisture,1 vegetation,2 food,3 wood,4 growth,5 fertility,6 cultivation,7 traffic,8 drinkingWater (double), 9 terrain,10 biome,11 feature (uchar), 12 life (double)
// Pointers are passed individually to keep the launch ABI explicit.
extern "C" __global__ void ecology_pass1(
  const int* cells,const unsigned int* stamps,const int* around,
  const double* moistureF,const double* vegetationF,const double* foodF,const double* woodF,const double* growthF,const double* fertilityF,const double* cultivationF,const double* trafficF,const double* drinkingF,const unsigned char* terrainF,const unsigned char* biomeF,const unsigned char* featureF,const double* lifeF,
  double* moistureB,double* vegetationB,double* foodB,double* woodB,double* growthB,double* fertilityB,double* cultivationB,double* trafficB,double* drinkingB,unsigned char* terrainB,unsigned char* biomeB,unsigned char* featureB,double* lifeB,
  int begin,int end,unsigned int version,int rain,double light,double capacidadBosque,double capacidadPastizal,double capacidadOtros,double velocidadRegeneracion,double decaimientoComida){
  int i=begin+(int)(blockIdx.x*blockDim.x+threadIdx.x);
  if(i>=end) return;
  int cell=cells[i];
  moistureB[cell]=moistureF[cell]; vegetationB[cell]=vegetationF[cell]; foodB[cell]=foodF[cell];
  woodB[cell]=woodF[cell]; growthB[cell]=growthF[cell]; fertilityB[cell]=fertilityF[cell];
  cultivationB[cell]=cultivationF[cell]; trafficB[cell]=trafficF[cell]; drinkingB[cell]=drinkingF[cell];
  lifeB[cell]=lifeF[cell]; terrainB[cell]=terrainF[cell]; biomeB[cell]=biomeF[cell]; featureB[cell]=featureF[cell];
  if(terrainF[cell]!=1){
    int present=0; int nearWater=0;
    int n;
    n=neighborCell(around,stamps,cell,-1,0,version,&present); if(present && terrainF[n]==1) nearWater=1;
    if(!nearWater){ n=neighborCell(around,stamps,cell,1,0,version,&present); if(present && terrainF[n]==1) nearWater=1; }
    if(!nearWater){ n=neighborCell(around,stamps,cell,0,-1,version,&present); if(present && terrainF[n]==1) nearWater=1; }
    if(!nearWater){ n=neighborCell(around,stamps,cell,0,1,version,&present); if(present && terrainF[n]==1) nearWater=1; }
    double moisture=bounded(moistureF[cell] + (rain?0.012:0) + (nearWater?0.008:0) - 0.0015 - light*0.001);
    moistureB[cell]=moisture;
    unsigned char biome=biomeF[cell];
    double K = biome==2?capacidadBosque:(biome==1?capacidadPastizal:capacidadOtros);
    double vegetation=vegetationF[cell];
    double headroom = K>0 ? 1 - vegetation/K : 0;
    double regen = velocidadRegeneracion * light * moisture * 0.007 * headroom;
    double nextVegetation=bounded(vegetation + regen - (moisture<0.15?0.0015:0.0001));
    vegetationB[cell]=nextVegetation;
    double food=foodF[cell];
    double foodHeadroom = K>0 ? 1 - food/K : 0;
    foodB[cell]=bounded(food + velocidadRegeneracion * light * moisture * nextVegetation * 0.006 * foodHeadroom - decaimientoComida);
  }
}
extern "C" __global__ void ecology_pass2(
  const int* cells,const unsigned int* stamps,const int* around,const int* pageX,const int* pageY,unsigned char* woodAdded,
  const double* moistureF,const double* vegetationF,const double* foodF,const double* woodF,const double* growthF,const double* fertilityF,const double* cultivationF,const double* trafficF,const double* drinkingF,const unsigned char* terrainF,const unsigned char* biomeF,const unsigned char* featureF,const double* lifeF,
  double* moistureB,double* vegetationB,double* foodB,double* woodB,double* growthB,double* fertilityB,double* cultivationB,double* trafficB,double* drinkingB,unsigned char* terrainB,unsigned char* biomeB,unsigned char* featureB,double* lifeB,
  int begin,int end,int tick,unsigned int version,int rain,double light,double decaimientoFertilidad,unsigned int seed,double cuencas){
  int i=begin+(int)(blockIdx.x*blockDim.x+threadIdx.x);
  if(i>=end) return;
  int cell=cells[i]; int slot=cell>>8; int lx=cell&15; int ly=(cell>>4)&15;
  double vegetation=vegetationF[cell]; double moisture=moistureF[cell];
  double growthRaw=growthF[cell]; double growth = (growthRaw!=growthRaw)?vegetation:growthRaw;
  double fertilityRaw=fertilityF[cell]; double fertility=(fertilityRaw!=fertilityRaw)?0:fertilityRaw;
  double trafficRaw=trafficF[cell]; double traffic=(trafficRaw!=trafficRaw)?0:trafficRaw;
  double cultivationRaw=cultivationF[cell]; double cultivation=(cultivationRaw!=cultivationRaw)?0:cultivationRaw;
  double drinkingRaw=drinkingF[cell]; double drinkingWater=(drinkingRaw!=drinkingRaw)?0:drinkingRaw;
  double lifeRaw=lifeF[cell]; double life=(lifeRaw!=lifeRaw)?0:lifeRaw;
  unsigned char localTerrain=terrainF[cell]; unsigned char localBiome=biomeF[cell]; unsigned char localFeature=featureF[cell];
  int livingNeighbors=0;
  for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++){
    if(dx==0&&dy==0) continue;
    int present=0; int n=neighborCell(around,stamps,cell,dx,dy,version,&present);
    if(present && lifeF[n]>=0.45) livingNeighbors++;
  }
  int fertilePattern = (livingNeighbors==3 || (life>=0.45 && livingNeighbors==2))?1:0;
  double cellularEnergy=light * moisture * (0.6 + fertility * 0.4);
  lifeB[cell]=bounded(life + ((fertilePattern?1.0:0.0)-life) * 0.2 * cellularEnergy - (moisture<0.15?0.015:0) - traffic * 0.004);
  fertilityB[cell]=bounded(fertility + life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002 - decaimientoFertilidad * fertility);
  double produced=light * moisture * fertility * (0.25 + life * 0.75) * (1 - growth) * (1 - traffic * 0.9) * 0.005;
  growthB[cell]=bounded(growth + produced - 0.0002 - traffic * 0.002 - (moisture<0.15?0.001:0));
  vegetationB[cell]= localTerrain!=1 ? bounded(vegetation + produced * 0.25 - traffic * 0.001) : vegetation;
  trafficB[cell]=bounded(traffic - 0.0005); cultivationB[cell]=bounded(cultivation - 0.00002);
  int reservoirSource = (localFeature==12 || localFeature==11 || localBiome==5 || localTerrain==1)?1:0;
  int reservoir=0;
  if(reservoirSource){
    if(localTerrain==1) reservoir=1;
    else {
      double gx=(double)(pageX[slot]*16 + lx); double gy=(double)(pageY[slot]*16 + ly);
      reservoir = basinNoiseFn(seed,gx,gy) < cuencas ? 1:0;
    }
  }
  drinkingB[cell]= localBiome==6 ? 0 : bounded(drinkingWater + (reservoir && rain ? 0.008 * (0.4 + fertility * 0.6) : 0) + (reservoir && localFeature==11 ? 0.002 : 0) - (light!=0 ? 0.00015 : 0.00003));
  moistureB[cell]= localTerrain==1 ? bounded(moisture + (localBiome==6?0.003:0) + (rain?0.008:0)) : moisture;
  woodB[cell]=woodF[cell]; featureB[cell]=localFeature; terrainB[cell]=localTerrain; biomeB[cell]=localBiome;
  foodB[cell]=foodF[cell];
  if(tick%100==0 && ((localFeature>=1 && localFeature<=5) || localFeature==10) && growth>0.65 && fertility>0.4 && moisture>0.35 && traffic<0.35 && light>0){
    double capacity = (localFeature==5 || localFeature==4)?2:(localFeature==3?6:12);
    double woodRaw=woodF[cell]; double wood=(woodRaw!=woodRaw)?0:woodRaw;
    double regrowth = capacity - wood; double prodWood = 0.025 * light * moisture * fertility;
    if(prodWood < regrowth) regrowth = prodWood;
    if(regrowth>0){
      woodB[cell]=wood + regrowth;
      growthB[cell]=bounded(growthB[cell] - regrowth * 0.05);
      if(woodRaw!=woodRaw && woodAdded[slot]==0) woodAdded[slot]=1;
      if(localFeature==10 && woodB[cell]>=1) featureB[cell]= localBiome==4?2:1;
    }
  }
}
