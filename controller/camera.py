"""Frames from the head-mounted OAK-1 W via the running depthai_ros_driver (it owns the device)."""
import time

import cv2
import numpy as np

IMAGE_TOPIC = '/oak/rgb/image_rect/compressed'
RAW_TOPIC = '/oak/rgb/image_raw/compressed'   # use when the driver's rectify node stalls; frames are undistorted here
INFO_TOPIC = '/oak/rgb/camera_info'


class RosCamera:
    def __init__(self, image_topic=IMAGE_TOPIC, info_topic=INFO_TOPIC, timeout=5):
        import rclpy
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import CameraInfo, CompressedImage
        self.rclpy = rclpy
        if not rclpy.ok():
            rclpy.init()
        self.node = rclpy.create_node('stylus_controller_camera')
        self.message, self.received_at, self.projection, self.info = None, 0.0, None, None
        self.rectify, self.maps = 'rect' not in image_topic, None
        self.node.create_subscription(CompressedImage, image_topic, self._image, qos_profile_sensor_data)
        self.node.create_subscription(CameraInfo, info_topic, self._info, qos_profile_sensor_data)
        self._spin_until(time.time() + timeout, lambda: self.projection is not None, 'camera_info')
        self.frame(timeout=timeout)

    def _image(self, message):
        self.message, self.received_at = message, time.time()

    def _info(self, message):
        self.projection, self.info = np.array(message.p, dtype=float).reshape(3, 4), message

    def _spin_until(self, deadline, done, what):
        while time.time() < deadline:
            self.rclpy.spin_once(self.node, timeout_sec=0.05)
            if done():
                return
        raise TimeoutError(f'No {what} from the ROS camera driver; is depthai_ros_driver running?')

    @property
    def fx(self):
        return self.projection[0, 0]

    @property
    def principal_point(self):
        return self.projection[0, 2], self.projection[1, 2]

    def frame(self, after=None, timeout=5, settle=0.15):
        """First frame received at least `settle` s after `after` (default: now), so it postdates any motion."""
        after = time.time() if after is None else after
        self._spin_until(time.time() + timeout, lambda: self.message is not None and self.received_at > after + settle, 'fresh frame')
        image = cv2.imdecode(np.frombuffer(bytes(self.message.data), np.uint8), cv2.IMREAD_COLOR)
        return self._undistort(image) if self.rectify else image

    def _undistort(self, image):
        """Same mapping as the driver's rectify node (K, D, R -> P), so fx and the principal point still apply."""
        if self.maps is None:
            info = self.info
            self.maps = cv2.initUndistortRectifyMap(
                np.reshape(info.k, (3, 3)), np.array(info.d), np.reshape(info.r, (3, 3)), self.projection[:, :3],
                (info.width, info.height), cv2.CV_16SC2)
        return cv2.remap(image, *self.maps, cv2.INTER_LINEAR)

    def close(self):
        self.node.destroy_node()
