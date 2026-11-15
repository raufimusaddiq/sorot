//! OS shim: does Rune draw on a CPU renderer (a software adapter such as WARP or lavapipe)?
//! No logic beyond the adapter's device type; the app decides what to do with the answer.

pub trait GpuProbe: Send + Sync {
    /// True when the adapter Rune would use is a software renderer. An unreadable GPU counts as one.
    fn software(&self) -> bool;
}

pub struct OsGpuProbe;

impl GpuProbe for OsGpuProbe {
    fn software(&self) -> bool {
        match rune::render::Gpu::try_new(rune::render::Gpu::instance(), None) {
            Ok(gpu) => gpu.adapter.get_info().device_type == wgpu::DeviceType::Cpu,
            Err(_) => true,
        }
    }
}
