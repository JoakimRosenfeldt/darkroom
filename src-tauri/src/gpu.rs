use std::{
    borrow::Cow,
    collections::HashMap,
    num::NonZeroU64,
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use wgpu::naga;

const MAX_BATCH_BYTES: usize = 512 * 1024 * 1024;
const MAX_TEXTURE_BYTES: u64 = 1536 * 1024 * 1024;
const MAX_SESSIONS: usize = 16;
const VERTEX: &str = r#"
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn main(@builtin(vertex_index) index: u32) -> Vertex {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return Vertex(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0), uv);
}
"#;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeGpuInfo {
    pub backend: String,
    pub adapter: String,
    pub device_type: String,
    pub max_texture_dimension: u32,
    pub max_texture_array_layers: u32,
    pub max_color_attachments: u32,
    pub max_color_attachment_bytes_per_sample: u32,
    pub rendered_frames: u64,
    pub rendered_passes: u64,
    pub active_sessions: usize,
    pub texture_bytes: u64,
    pub last_frame_ms: f64,
    pub last_prepare_ms: f64,
    pub last_gpu_wait_ms: f64,
    pub last_pack_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    session: String,
    #[serde(default)]
    shaders: Vec<ShaderSpec>,
    #[serde(default)]
    textures: Vec<TextureSpec>,
    #[serde(default)]
    delete_textures: Vec<u32>,
    #[serde(default)]
    passes: Vec<Pass>,
    #[serde(default)]
    reads: Vec<Read>,
    #[serde(default)]
    release: bool,
    #[serde(default)]
    info: bool,
}

#[derive(Deserialize)]
struct ShaderSpec {
    id: u32,
    source: String,
}

#[derive(Deserialize)]
struct TextureSpec {
    id: u32,
    width: u32,
    height: u32,
    #[serde(default = "one")]
    layers: u32,
    format: String,
    offset: Option<usize>,
    length: Option<usize>,
}

fn one() -> u32 {
    1
}

#[derive(Deserialize)]
struct ByteRange {
    offset: usize,
    length: usize,
}

#[derive(Deserialize)]
struct Pass {
    shader: u32,
    targets: Vec<u32>,
    textures: Vec<u32>,
    uniforms: ByteRange,
}

#[derive(Deserialize)]
struct Read {
    texture: u32,
    format: String,
}

struct Texture {
    value: wgpu::Texture,
    view: wgpu::TextureView,
    array_view: wgpu::TextureView,
    width: u32,
    height: u32,
    layers: u32,
    format: wgpu::TextureFormat,
    bytes: u64,
}

struct Shader {
    module: wgpu::ShaderModule,
    layout: wgpu::BindGroupLayout,
    textures: Vec<(u32, wgpu::TextureViewDimension)>,
    sampler_binding: Option<u32>,
    pipelines: HashMap<Vec<Option<wgpu::TextureFormat>>, wgpu::RenderPipeline>,
}

#[derive(Default)]
struct Session {
    shaders: HashMap<u32, Arc<str>>,
    textures: HashMap<u32, Texture>,
    uniform_buffer: Option<(wgpu::Buffer, u64)>,
    read_buffer: Option<(wgpu::Buffer, u64)>,
}

pub struct NativeGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    vertex: wgpu::ShaderModule,
    sampler: wgpu::Sampler,
    info: NativeGpuInfo,
    sessions: HashMap<String, Session>,
    shader_cache: HashMap<Arc<str>, Shader>,
    texture_bytes: u64,
}

impl NativeGpu {
    pub fn new() -> Result<Self, String> {
        let backends = if cfg!(target_os = "macos") {
            wgpu::Backends::METAL
        } else {
            wgpu::Backends::VULKAN
        };
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends,
            ..Default::default()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .map_err(|error| format!("Native GPU unavailable: {error}"))?;
        let adapter_info = adapter.get_info();
        let supported = adapter.limits();
        let limits = wgpu::Limits {
            max_texture_dimension_2d: supported.max_texture_dimension_2d,
            max_texture_array_layers: supported.max_texture_array_layers,
            max_color_attachment_bytes_per_sample: supported.max_color_attachment_bytes_per_sample,
            max_color_attachments: supported.max_color_attachments,
            max_buffer_size: supported.max_buffer_size.min(MAX_TEXTURE_BYTES),
            ..wgpu::Limits::default()
        };
        let features =
            adapter.features() & wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Darkroom native rendering"),
            required_features: features,
            required_limits: limits,
            ..Default::default()
        }))
        .map_err(|error| format!("Native GPU device: {error}"))?;
        let vertex = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Darkroom fullscreen triangle"),
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(VERTEX)),
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let info = NativeGpuInfo {
            backend: format!("{:?}", adapter_info.backend),
            adapter: adapter_info.name,
            device_type: format!("{:?}", adapter_info.device_type),
            max_texture_dimension: device.limits().max_texture_dimension_2d,
            max_texture_array_layers: device.limits().max_texture_array_layers,
            max_color_attachments: device.limits().max_color_attachments,
            max_color_attachment_bytes_per_sample: device
                .limits()
                .max_color_attachment_bytes_per_sample,
            rendered_frames: 0,
            rendered_passes: 0,
            active_sessions: 0,
            texture_bytes: 0,
            last_frame_ms: 0.0,
            last_prepare_ms: 0.0,
            last_gpu_wait_ms: 0.0,
            last_pack_ms: 0.0,
        };
        Ok(Self {
            device,
            queue,
            vertex,
            sampler,
            info,
            sessions: HashMap::new(),
            shader_cache: HashMap::new(),
            texture_bytes: 0,
        })
    }

    pub fn info(&self) -> NativeGpuInfo {
        NativeGpuInfo {
            active_sessions: self.sessions.len(),
            texture_bytes: self.texture_bytes,
            ..self.info.clone()
        }
    }

    pub fn execute(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        if bytes.len() < 4 || bytes.len() > MAX_BATCH_BYTES {
            return Err("Invalid native GPU batch length".into());
        }
        let json_len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        if json_len > 8 * 1024 * 1024 || json_len > bytes.len() - 4 {
            return Err("Invalid native GPU metadata length".into());
        }
        let batch: Batch = serde_json::from_slice(&bytes[4..4 + json_len])
            .map_err(|error| format!("Native GPU metadata: {error}"))?;
        if batch.info {
            return serde_json::to_vec(&self.info()).map_err(|error| error.to_string());
        }
        if batch.session.is_empty()
            || batch.session.len() > 128
            || batch.passes.len() > 256
            || batch.textures.len() > 512
            || batch.shaders.len() > 128
            || batch.reads.len() > 16
        {
            return Err("Native GPU batch exceeds resource limits".into());
        }
        if batch.release {
            if let Some(session) = self.sessions.remove(&batch.session) {
                self.texture_bytes -= session
                    .textures
                    .values()
                    .map(|texture| texture.bytes)
                    .sum::<u64>();
            }
            return Ok(Vec::new());
        }
        if !self.sessions.contains_key(&batch.session) && self.sessions.len() >= MAX_SESSIONS {
            return Err("Too many native GPU sessions".into());
        }
        let mut session = self.sessions.remove(&batch.session).unwrap_or_default();
        self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let result = self.execute_batch(&mut session, &batch, &bytes[4 + json_len..]);
        let validation = pollster::block_on(self.device.pop_error_scope());
        let memory = pollster::block_on(self.device.pop_error_scope());
        let result = result.and_then(|bytes| match validation.or(memory) {
            Some(error) => Err(format!("Native GPU: {error}")),
            None => Ok(bytes),
        });
        if result.is_ok() {
            if !batch.passes.is_empty() {
                self.info.last_frame_ms = started.elapsed().as_secs_f64() * 1000.0;
            }
            self.info.rendered_frames += u64::from(!batch.passes.is_empty());
            self.info.rendered_passes += batch.passes.len() as u64;
            self.sessions.insert(batch.session, session);
        } else {
            self.texture_bytes -= session
                .textures
                .values()
                .map(|texture| texture.bytes)
                .sum::<u64>();
            drop(session);
            self.shader_cache
                .retain(|key, _| Arc::strong_count(key) > 1);
        }
        result
    }

    fn execute_batch(
        &mut self,
        session: &mut Session,
        batch: &Batch,
        data: &[u8],
    ) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        for id in &batch.delete_textures {
            if let Some(texture) = session.textures.remove(id) {
                self.texture_bytes -= texture.bytes;
            }
        }
        for spec in &batch.shaders {
            if spec.source.len() > 512 * 1024 {
                return Err("Native shader exceeds size limit".into());
            }
            let key = if let Some((key, _)) = self.shader_cache.get_key_value(spec.source.as_str())
            {
                Arc::clone(key)
            } else {
                if self.shader_cache.len() >= 32 {
                    self.shader_cache
                        .retain(|key, _| Arc::strong_count(key) > 1);
                }
                if self.shader_cache.len() >= 32 {
                    return Err("Native shader cache exceeds size limit".into());
                }
                let key: Arc<str> = Arc::from(spec.source.as_str());
                let shader = self.create_shader(&spec.source)?;
                self.shader_cache.insert(Arc::clone(&key), shader);
                key
            };
            session.shaders.insert(spec.id, key);
        }
        if session.shaders.len() > 128 {
            return Err("Native shader cache exceeds size limit".into());
        }
        for spec in &batch.textures {
            if !session.textures.contains_key(&spec.id) && session.textures.len() >= 512 {
                return Err("Native texture cache exceeds size limit".into());
            }
            let format = texture_format(&spec.format)?;
            let bpp = bytes_per_pixel(format);
            let size = u64::from(spec.width)
                * u64::from(spec.height)
                * u64::from(spec.layers)
                * u64::from(bpp);
            if spec.width == 0
                || spec.height == 0
                || spec.layers == 0
                || spec.width > self.info.max_texture_dimension
                || spec.height > self.info.max_texture_dimension
                || spec.layers > self.info.max_texture_array_layers
            {
                return Err("Native texture has unsupported dimensions".into());
            }
            let old_size = session
                .textures
                .get(&spec.id)
                .map_or(0, |texture| texture.bytes);
            if self.texture_bytes - old_size + size > MAX_TEXTURE_BYTES {
                return Err("Native texture memory limit exceeded".into());
            }
            let input = match (spec.offset, spec.length) {
                (Some(offset), Some(length)) => {
                    if length as u64 != size {
                        return Err(format!(
                            "Texture {} requires {size} bytes, got {length}",
                            spec.id
                        ));
                    }
                    Some(byte_range(data, offset, length)?)
                }
                (None, None) => None,
                _ => return Err("Native texture needs both offset and length".into()),
            };
            let extent = wgpu::Extent3d {
                width: spec.width,
                height: spec.height,
                depth_or_array_layers: spec.layers,
            };
            let usage = wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT;
            let value = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Darkroom image"),
                size: extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            });
            if let Some(input) = input {
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &value,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    input,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(spec.width * bpp),
                        rows_per_image: Some(spec.height),
                    },
                    extent,
                );
            }
            let view = value.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2),
                array_layer_count: Some(1),
                ..Default::default()
            });
            let array_view = value.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });
            session.textures.insert(
                spec.id,
                Texture {
                    value,
                    view,
                    array_view,
                    width: spec.width,
                    height: spec.height,
                    layers: spec.layers,
                    format,
                    bytes: size,
                },
            );
            self.texture_bytes = self.texture_bytes - old_size + size;
        }
        let uniform_alignment = self.device.limits().min_uniform_buffer_offset_alignment as usize;
        let mut uniform_data = Vec::new();
        let mut uniform_ranges = Vec::with_capacity(batch.passes.len());
        for pass in &batch.passes {
            if pass.uniforms.length > self.device.limits().max_uniform_buffer_binding_size as usize
            {
                return Err("Native uniform block too large".into());
            }
            let offset = align(uniform_data.len(), uniform_alignment);
            uniform_data.resize(offset, 0);
            uniform_data.extend_from_slice(byte_range(
                data,
                pass.uniforms.offset,
                pass.uniforms.length,
            )?);
            let length = align(pass.uniforms.length.max(16), 16);
            uniform_data.resize(offset + length, 0);
            uniform_ranges.push((offset as u64, length as u64));
        }
        if !uniform_data.is_empty() {
            reserve_buffer(
                &self.device,
                &mut session.uniform_buffer,
                uniform_data.len() as u64,
                wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            );
            self.queue.write_buffer(
                &session.uniform_buffer.as_ref().unwrap().0,
                0,
                &uniform_data,
            );
        }
        let mut pass_groups = Vec::with_capacity(batch.passes.len());
        for pass in &batch.passes {
            let formats = self.validate_pass(session, pass)?;
            let groups = target_groups(&formats, self.info.max_color_attachment_bytes_per_sample);
            let key = session
                .shaders
                .get(&pass.shader)
                .ok_or("Unknown native shader")?;
            let shader = self
                .shader_cache
                .get_mut(key)
                .ok_or("Unknown native shader")?;
            for formats in &groups {
                if !shader.pipelines.contains_key(formats) {
                    if shader.pipelines.len() >= 32 {
                        return Err("Native pipeline cache exceeds size limit".into());
                    }
                    let layout =
                        self.device
                            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                                label: Some("Darkroom pass layout"),
                                bind_group_layouts: &[&shader.layout],
                                push_constant_ranges: &[],
                            });
                    let targets: Vec<_> = formats
                        .iter()
                        .map(|format| {
                            format.map(|format| wgpu::ColorTargetState {
                                format,
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })
                        })
                        .collect();
                    let pipeline =
                        self.device
                            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                                label: Some("Darkroom develop pass"),
                                layout: Some(&layout),
                                vertex: wgpu::VertexState {
                                    module: &self.vertex,
                                    entry_point: Some("main"),
                                    compilation_options: Default::default(),
                                    buffers: &[],
                                },
                                primitive: wgpu::PrimitiveState::default(),
                                depth_stencil: None,
                                multisample: Default::default(),
                                fragment: Some(wgpu::FragmentState {
                                    module: &shader.module,
                                    entry_point: Some("main"),
                                    compilation_options: Default::default(),
                                    targets: &targets,
                                }),
                                multiview: None,
                                cache: None,
                            });
                    shader.pipelines.insert(formats.clone(), pipeline);
                }
            }
            pass_groups.push(groups);
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Darkroom native frame"),
            });
        for (index, pass) in batch.passes.iter().enumerate() {
            let shader = &self.shader_cache[&session.shaders[&pass.shader]];
            let targets: Vec<_> = pass
                .targets
                .iter()
                .map(|id| &session.textures[id])
                .collect();
            let (offset, length) = uniform_ranges[index];
            let mut entries = vec![wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &session.uniform_buffer.as_ref().unwrap().0,
                    offset,
                    size: NonZeroU64::new(length),
                }),
            }];
            for ((binding, dimension), id) in shader.textures.iter().zip(&pass.textures) {
                let texture = &session.textures[id];
                entries.push(wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: wgpu::BindingResource::TextureView(
                        if *dimension == wgpu::TextureViewDimension::D2Array {
                            &texture.array_view
                        } else {
                            &texture.view
                        },
                    ),
                });
            }
            if let Some(binding) = shader.sampler_binding {
                entries.push(wgpu::BindGroupEntry {
                    binding,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                });
            }
            let bindings = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Darkroom pass bindings"),
                layout: &shader.layout,
                entries: &entries,
            });
            for formats in &pass_groups[index] {
                let attachments: Vec<_> = targets
                    .iter()
                    .zip(formats)
                    .map(|(texture, format)| {
                        format.map(|_| wgpu::RenderPassColorAttachment {
                            view: &texture.view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                        })
                    })
                    .collect();
                let mut render = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Darkroom develop pass"),
                    color_attachments: &attachments,
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                render.set_pipeline(&shader.pipelines[formats]);
                render.set_bind_group(0, &bindings, &[]);
                render.draw(0..3, 0..1);
            }
        }
        let mut read_size = 0usize;
        let mut output_size = 0usize;
        let mut read_layouts = Vec::with_capacity(batch.reads.len());
        for read in &batch.reads {
            let texture = session
                .textures
                .get(&read.texture)
                .ok_or("Unknown native read texture")?;
            if read.format != "rgba8" && read.format != "rgba32f" {
                return Err("Unknown native read format".into());
            }
            if texture.layers != 1 {
                return Err("Cannot read an array texture".into());
            }
            output_size += texture.width as usize
                * texture.height as usize
                * if read.format == "rgba8" { 4 } else { 16 };
            if output_size > MAX_BATCH_BYTES {
                return Err("Native output exceeds memory limit".into());
            }
            let row_bytes = texture.width as usize * bytes_per_pixel(texture.format) as usize;
            let padded_row = align(row_bytes, wgpu::COPY_BYTES_PER_ROW_ALIGNMENT as usize);
            read_layouts.push((read_size, row_bytes, padded_row));
            read_size += padded_row * texture.height as usize;
        }
        if read_size > MAX_BATCH_BYTES {
            return Err("Native readback exceeds memory limit".into());
        }
        if read_size > 0 {
            reserve_buffer(
                &self.device,
                &mut session.read_buffer,
                read_size as u64,
                wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            );
            for (read, (offset, _, padded_row)) in batch.reads.iter().zip(&read_layouts) {
                let texture = &session.textures[&read.texture];
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture.value,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyBufferInfo {
                        buffer: &session.read_buffer.as_ref().unwrap().0,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: *offset as u64,
                            bytes_per_row: Some(*padded_row as u32),
                            rows_per_image: Some(texture.height),
                        },
                    },
                    wgpu::Extent3d {
                        width: texture.width,
                        height: texture.height,
                        depth_or_array_layers: 1,
                    },
                );
            }
        }
        let commands = encoder.finish();
        self.check_errors()?;
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        let wait_started = Instant::now();
        let submission = self.queue.submit([commands]);
        self.check_errors()?;
        if read_size == 0 {
            return Ok(Vec::new());
        }
        let buffer = &session.read_buffer.as_ref().unwrap().0;
        let slice = buffer.slice(..read_size as u64);
        let (sender, receiver) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        self.device
            .poll(wgpu::PollType::WaitForSubmissionIndex(submission))
            .map_err(|error| format!("Native GPU wait: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("Native readback callback: {error}"))?
            .map_err(|error| format!("Native readback: {error}"))?;
        let mapped = slice.get_mapped_range();
        let gpu_wait_ms = wait_started.elapsed().as_secs_f64() * 1000.0;
        let pack_started = Instant::now();
        let mut output = Vec::new();
        for (read, (offset, row_bytes, padded_row)) in batch.reads.iter().zip(read_layouts) {
            let texture = &session.textures[&read.texture];
            let output_bpp = if read.format == "rgba8" { 4 } else { 16 };
            let output_size = texture.width as usize * texture.height as usize * output_bpp;
            let start = output.len();
            output.resize(start + output_size, 0);
            let convert_row = |(row, destination): (usize, &mut [u8])| {
                let source =
                    &mapped[offset + row * padded_row..offset + row * padded_row + row_bytes];
                convert_pixels(source, destination, texture.format, output_bpp);
            };
            if output_size >= 256 * 1024
                && let Some(pool) = crate::compute::pool()
            {
                pool.install(|| {
                    output[start..]
                        .par_chunks_mut(texture.width as usize * output_bpp)
                        .enumerate()
                        .for_each(convert_row)
                });
            } else {
                output[start..]
                    .chunks_mut(texture.width as usize * output_bpp)
                    .enumerate()
                    .for_each(convert_row);
            }
        }
        drop(mapped);
        buffer.unmap();
        if !batch.passes.is_empty() {
            self.info.last_prepare_ms = prepare_ms;
            self.info.last_gpu_wait_ms = gpu_wait_ms;
            self.info.last_pack_ms = pack_started.elapsed().as_secs_f64() * 1000.0;
        }
        Ok(output)
    }

    fn check_errors(&self) -> Result<(), String> {
        let validation = pollster::block_on(self.device.pop_error_scope());
        let memory = pollster::block_on(self.device.pop_error_scope());
        self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        match validation.or(memory) {
            Some(error) => Err(format!("Native GPU: {error}")),
            None => Ok(()),
        }
    }

    fn validate_pass(
        &self,
        session: &Session,
        pass: &Pass,
    ) -> Result<Vec<wgpu::TextureFormat>, String> {
        let key = session
            .shaders
            .get(&pass.shader)
            .ok_or("Unknown native shader")?;
        let shader = self.shader_cache.get(key).ok_or("Unknown native shader")?;
        if pass.targets.is_empty()
            || pass.targets.len() > self.info.max_color_attachments as usize
            || pass.textures.len() != shader.textures.len()
        {
            return Err(format!(
                "Invalid native pass attachments or textures for shader {}: {} supplied, {} expected",
                pass.shader,
                pass.textures.len(),
                shader.textures.len()
            ));
        }
        let mut size = None;
        let mut formats = Vec::new();
        for id in &pass.targets {
            let texture = session
                .textures
                .get(id)
                .ok_or("Unknown native render target")?;
            let dimensions = (texture.width, texture.height);
            if texture.layers != 1
                || size.is_some_and(|size| size != dimensions)
                || pass.textures.contains(id)
            {
                return Err("Invalid native render target dimensions or feedback loop".into());
            }
            size = Some(dimensions);
            formats.push(texture.format);
        }
        for id in &pass.textures {
            if !session.textures.contains_key(id) {
                return Err(format!("Unknown native source texture {id}"));
            }
        }
        Ok(formats)
    }

    fn create_shader(&self, source: &str) -> Result<Shader, String> {
        let module = naga::front::glsl::Frontend::default()
            .parse(
                &naga::front::glsl::Options::from(naga::ShaderStage::Fragment),
                source,
            )
            .map_err(|error| format!("Native shader GLSL: {}", error.emit_to_string(source)))?;
        let mut entries = vec![wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }];
        let mut textures = Vec::new();
        let mut sampler_binding = None;
        for (_, global) in module.global_variables.iter() {
            let Some(binding) = &global.binding else {
                continue;
            };
            if binding.group != 0 {
                return Err("Native shader must use descriptor set zero".into());
            }
            let ty = match module.types[global.ty].inner {
                naga::TypeInner::Image {
                    dim: naga::ImageDimension::D2,
                    arrayed,
                    class: naga::ImageClass::Sampled { kind, .. },
                } => {
                    let dimension = if arrayed {
                        wgpu::TextureViewDimension::D2Array
                    } else {
                        wgpu::TextureViewDimension::D2
                    };
                    textures.push((binding.binding, dimension));
                    wgpu::BindingType::Texture {
                        sample_type: match kind {
                            naga::ScalarKind::Uint => wgpu::TextureSampleType::Uint,
                            naga::ScalarKind::Sint => wgpu::TextureSampleType::Sint,
                            _ => wgpu::TextureSampleType::Float { filterable: false },
                        },
                        view_dimension: dimension,
                        multisampled: false,
                    }
                }
                naga::TypeInner::Sampler { comparison: false } => {
                    if sampler_binding.replace(binding.binding).is_some() {
                        return Err("Native shader accepts one shared sampler".into());
                    }
                    wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering)
                }
                _ if binding.binding == 0 => continue,
                _ => return Err("Unsupported native shader resource".into()),
            };
            entries.push(wgpu::BindGroupLayoutEntry {
                binding: binding.binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty,
                count: None,
            });
        }
        textures.sort_by_key(|(binding, _)| *binding);
        let layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Darkroom shader bindings"),
                entries: &entries,
            });
        let module = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Darkroom GLSL develop shader"),
                source: wgpu::ShaderSource::Naga(Cow::Owned(module)),
            });
        Ok(Shader {
            module,
            layout,
            textures,
            sampler_binding,
            pipelines: HashMap::new(),
        })
    }
}

fn texture_format(name: &str) -> Result<wgpu::TextureFormat, String> {
    Ok(match name {
        "rgba8unorm" => wgpu::TextureFormat::Rgba8Unorm,
        "rgba16uint" => wgpu::TextureFormat::Rgba16Uint,
        "rgba32uint" => wgpu::TextureFormat::Rgba32Uint,
        "rgba16float" => wgpu::TextureFormat::Rgba16Float,
        "rgba32float" => wgpu::TextureFormat::Rgba32Float,
        "r32float" => wgpu::TextureFormat::R32Float,
        _ => return Err(format!("Unknown native texture format {name}")),
    })
}

fn bytes_per_pixel(format: wgpu::TextureFormat) -> u32 {
    match format {
        wgpu::TextureFormat::Rgba16Uint | wgpu::TextureFormat::Rgba16Float => 8,
        wgpu::TextureFormat::Rgba32Uint | wgpu::TextureFormat::Rgba32Float => 16,
        _ => 4,
    }
}

fn byte_range(data: &[u8], offset: usize, length: usize) -> Result<&[u8], String> {
    data.get(
        offset
            ..offset
                .checked_add(length)
                .ok_or("Native buffer range overflow")?,
    )
    .ok_or_else(|| "Native buffer range is outside the batch".into())
}

fn align(value: usize, alignment: usize) -> usize {
    value.div_ceil(alignment) * alignment
}

fn reserve_buffer(
    device: &wgpu::Device,
    slot: &mut Option<(wgpu::Buffer, u64)>,
    size: u64,
    usage: wgpu::BufferUsages,
) {
    if slot.as_ref().is_none_or(|(_, allocated)| *allocated < size) {
        *slot = Some((
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Darkroom frame buffer"),
                size,
                usage,
                mapped_at_creation: false,
            }),
            size,
        ));
    }
}

fn convert_pixels(
    source: &[u8],
    destination: &mut [u8],
    format: wgpu::TextureFormat,
    output_bpp: usize,
) {
    if (format == wgpu::TextureFormat::Rgba8Unorm && output_bpp == 4)
        || (format == wgpu::TextureFormat::Rgba32Float && output_bpp == 16)
    {
        destination.copy_from_slice(source);
        return;
    }
    let bpp = bytes_per_pixel(format) as usize;
    for (input, output) in source
        .chunks_exact(bpp)
        .zip(destination.chunks_exact_mut(output_bpp))
    {
        for channel in 0..4 {
            let value = match format {
                wgpu::TextureFormat::Rgba16Float => half::f16::from_bits(u16::from_le_bytes(
                    input[channel * 2..channel * 2 + 2].try_into().unwrap(),
                ))
                .to_f32(),
                wgpu::TextureFormat::Rgba16Uint => {
                    u16::from_le_bytes(input[channel * 2..channel * 2 + 2].try_into().unwrap())
                        as f32
                }
                wgpu::TextureFormat::Rgba32Uint => {
                    u32::from_le_bytes(input[channel * 4..channel * 4 + 4].try_into().unwrap())
                        as f32
                }
                wgpu::TextureFormat::Rgba32Float => {
                    f32::from_le_bytes(input[channel * 4..channel * 4 + 4].try_into().unwrap())
                }
                wgpu::TextureFormat::R32Float if channel == 0 => {
                    f32::from_le_bytes(input.try_into().unwrap())
                }
                wgpu::TextureFormat::R32Float => {
                    if channel == 3 {
                        1.0
                    } else {
                        0.0
                    }
                }
                _ => input[channel] as f32 / 255.0,
            };
            if output_bpp == 4 {
                output[channel] = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
            } else {
                output[channel * 4..channel * 4 + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
    }
}

fn target_groups(
    formats: &[wgpu::TextureFormat],
    limit: u32,
) -> Vec<Vec<Option<wgpu::TextureFormat>>> {
    let mut groups = Vec::new();
    let mut current = vec![None; formats.len()];
    let mut used = 0;
    for (index, format) in formats.iter().enumerate() {
        let bytes = bytes_per_pixel(*format);
        if used > 0 && used + bytes > limit {
            groups.push(current);
            current = vec![None; formats.len()];
            used = 0;
        }
        current[index] = Some(*format);
        used += bytes;
    }
    groups.push(current);
    groups
}
