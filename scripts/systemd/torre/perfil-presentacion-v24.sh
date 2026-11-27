# Cargar después de perfil-v24.sh en la presentación de la torre.
export CARTA_MOTOR_HILOS=32
export CARTA_MOTOR_GPU=0,1
export COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so
export CARTA_PERCEPCION_DUENOS=1 CARTA_PERCEPCION_COSTE_DUENOS=1
# Alternar los grupos permite que ambas tarjetas reciban trabajo aun con pocas páginas activas.
# La 5070 Ti recibe 24 dueños y la 2060 recibe 8.
export CARTA_MOTOR_GPU_GRUPOS='[[0,2,3,4,6,7,8,10,11,12,14,15,16,18,19,20,22,23,24,26,27,28,30,31],[1,5,9,13,17,21,25,29]]'
