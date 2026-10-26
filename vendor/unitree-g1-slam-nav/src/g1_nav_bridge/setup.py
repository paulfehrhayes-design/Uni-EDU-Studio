from setuptools import find_packages, setup

package_name = 'g1_nav_bridge'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/launch', ['launch/nav_bridge.launch.py']),
        ('share/' + package_name + '/config', ['config/nav_bridge.yaml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='unitree',
    maintainer_email='unitree@todo.todo',
    description='TODO: Package description',
    license='TODO: License declaration',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
		'cmdvel_to_sport = g1_nav_bridge.cmdvel_to_sport:main',
		'odom_tf_broadcaster = g1_nav_bridge.odom_tf_broadcaster:main',
		'scan_restamper = g1_nav_bridge.scan_restamper:main',
        ],
    },
)
