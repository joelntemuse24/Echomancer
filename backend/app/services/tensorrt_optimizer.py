import torch
import logging
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class TensorRTOptimizer:
    """TensorRT optimization for maximum GPU performance"""
    
    def __init__(self):
        self.engine_cache = {}
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
    def optimize_model(self, model: torch.nn.Module, input_shape: tuple, model_name: str = "model") -> Optional[Any]:
        """Convert PyTorch model to TensorRT engine"""
        try:
            # Check if TensorRT is available
            import tensorrt as trt
            logger.info("TensorRT available, optimizing model...")
            
            # Create TensorRT engine
            engine = self._build_tensorrt_engine(model, input_shape, model_name)
            
            if engine:
                self.engine_cache[model_name] = engine
                logger.info(f"Model {model_name} optimized with TensorRT")
                return engine
            else:
                logger.warning(f"Failed to optimize {model_name} with TensorRT")
                return None
                
        except ImportError:
            logger.info("TensorRT not available, using PyTorch model")
            return None
        except Exception as e:
            logger.error(f"TensorRT optimization failed: {e}")
            return None
    
    def _build_tensorrt_engine(self, model: torch.nn.Module, input_shape: tuple, model_name: str) -> Optional[Any]:
        """Build TensorRT engine from PyTorch model"""
        try:
            import tensorrt as trt
            
            # Create logger
            TRT_LOGGER = trt.Logger(trt.Logger.WARNING)
            
            # Create builder
            builder = trt.Builder(TRT_LOGGER)
            network = builder.create_network(1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH))
            parser = trt.OnnxParser(network, TRT_LOGGER)
            
            # Export to ONNX first
            onnx_path = self._export_to_onnx(model, input_shape, model_name)
            
            # Parse ONNX model
            with open(onnx_path, 'rb') as model_file:
                if not parser.parse(model_file.read()):
                    logger.error("Failed to parse ONNX model")
                    return None
            
            # Build config
            config = builder.create_builder_config()
            config.max_workspace_size = 1 << 30  # 1GB
            
            # Enable FP16 for better performance
            if builder.platform_has_fast_fp16:
                config.set_flag(trt.BuilderFlag.FP16)
                logger.info("Enabled FP16 optimization")
            
            # Build engine
            engine = builder.build_engine(network, config)
            
            if engine:
                # Save engine for future use
                engine_path = Path(f"{model_name}.engine")
                with open(engine_path, 'wb') as f:
                    f.write(engine.serialize())
                logger.info(f"TensorRT engine saved to {engine_path}")
            
            return engine
            
        except Exception as e:
            logger.error(f"Failed to build TensorRT engine: {e}")
            return None
    
    def _export_to_onnx(self, model: torch.nn.Module, input_shape: tuple, model_name: str) -> Path:
        """Export PyTorch model to ONNX"""
        model.eval()
        
        # Create dummy input
        dummy_input = torch.randn(input_shape).to(self.device)
        
        # Export path
        onnx_path = Path(f"{model_name}.onnx")
        
        # Export to ONNX
        torch.onnx.export(
            model,
            dummy_input,
            onnx_path,
            export_params=True,
            opset_version=14,
            do_constant_folding=True,
            input_names=['input'],
            output_names=['output'],
            dynamic_axes={
                'input': {0: 'batch_size'},
                'output': {0: 'batch_size'}
            }
        )
        
        logger.info(f"Model exported to ONNX: {onnx_path}")
        return onnx_path
    
    def load_optimized_model(self, model_name: str) -> Optional[Any]:
        """Load optimized TensorRT model"""
        try:
            import tensorrt as trt
            
            engine_path = Path(f"{model_name}.engine")
            if not engine_path.exists():
                return None
            
            # Load engine
            TRT_LOGGER = trt.Logger(trt.Logger.WARNING)
            with open(engine_path, 'rb') as f, trt.Runtime(TRT_LOGGER) as runtime:
                engine = runtime.deserialize_cuda_engine(f.read())
                return engine
                
        except Exception as e:
            logger.error(f"Failed to load optimized model: {e}")
            return None
    
    def benchmark_model(self, model: torch.nn.Module, input_shape: tuple, model_name: str = "model") -> Dict[str, float]:
        """Benchmark model performance"""
        model.eval()
        
        # Warmup
        dummy_input = torch.randn(input_shape).to(self.device)
        for _ in range(10):
            with torch.no_grad():
                _ = model(dummy_input)
        
        # Benchmark
        import time
        torch.cuda.synchronize()
        
        start_time = time.time()
        for _ in range(100):
            with torch.no_grad():
                output = model(dummy_input)
        torch.cuda.synchronize()
        
        end_time = time.time()
        
        avg_time = (end_time - start_time) / 100
        throughput = 1.0 / avg_time
        
        return {
            'avg_time_ms': avg_time * 1000,
            'throughput_fps': throughput,
            'model_name': model_name
        }
    
    def get_gpu_memory_info(self) -> Dict[str, Any]:
        """Get GPU memory information"""
        if torch.cuda.is_available():
            return {
                'allocated_gb': torch.cuda.memory_allocated() / 1e9,
                'cached_gb': torch.cuda.memory_reserved() / 1e9,
                'max_allocated_gb': torch.cuda.max_memory_allocated() / 1e9,
                'total_gb': torch.cuda.get_device_properties(0).total_memory / 1e9
            }
        else:
            return {'error': 'CUDA not available'}

# Global optimizer instance
tensorrt_optimizer = TensorRTOptimizer()
