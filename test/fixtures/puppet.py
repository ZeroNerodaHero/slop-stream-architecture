# blender -b --python puppet.py -- <out dir>
#
# A model made of boxes, for the tests: a head with two eyes and a mouth on a neck, a body and
# two arms, on a skeleton whose bones are named the plain way (Hips, Spine, Chest, Neck, Head,
# LeftArm, RightArm), with two shapes (Blink, MouthOpen) and one small picture for its colours.
# Written as an fbx with the picture inside it (puppet.fbx), as one with the picture left
# outside (puppet-loose.fbx), and as a glb (puppet.glb).
import bmesh
import bpy
import os
import sys
from mathutils import Matrix, Vector

out = sys.argv[sys.argv.index('--') + 1]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

# the picture: four colours, a quarter each. skin top left, dark top right, red bottom left, blue bottom right
SIZE = 4
image = bpy.data.images.new('puppet', SIZE, SIZE)
COLOURS = {'skin': (0.94, 0.72, 0.6, 1), 'dark': (0.07, 0.07, 0.1, 1), 'red': (0.75, 0.1, 0.12, 1), 'blue': (0.15, 0.3, 0.75, 1)}
WHERE = {'skin': (0.25, 0.75), 'dark': (0.75, 0.75), 'red': (0.25, 0.25), 'blue': (0.75, 0.25)}
pixels = []
for y in range(SIZE):  # rows from the bottom up
    for x in range(SIZE):
        name = ('red' if x < SIZE // 2 else 'blue') if y < SIZE // 2 else ('skin' if x < SIZE // 2 else 'dark')
        pixels.extend(COLOURS[name])
image.pixels = pixels
image.filepath_raw = os.path.join(out, 'puppet.png')
image.file_format = 'PNG'
image.save()

material = bpy.data.materials.new('puppet')
material.use_nodes = True
texture = material.node_tree.nodes.new('ShaderNodeTexImage')
texture.image = image
texture.interpolation = 'Closest'
bsdf = material.node_tree.nodes['Principled BSDF']
material.node_tree.links.new(bsdf.inputs['Base Color'], texture.outputs['Color'])

# the boxes: a name, the bone that moves it, its colour, its middle and its size. it faces -y, its left is +x, z is up
PARTS = [
    ('body', 'Chest', 'blue', (0, 0, 1.15), (0.36, 0.2, 0.5)),
    ('neck', 'Neck', 'skin', (0, 0, 1.45), (0.1, 0.1, 0.1)),
    ('head', 'Head', 'skin', (0, 0, 1.65), (0.3, 0.26, 0.3)),
    ('eye.L', 'Head', 'dark', (0.07, -0.135, 1.69), (0.06, 0.02, 0.06)),
    ('eye.R', 'Head', 'dark', (-0.07, -0.135, 1.69), (0.06, 0.02, 0.06)),
    ('mouth', 'Head', 'red', (0, -0.135, 1.57), (0.12, 0.02, 0.02)),
    ('arm.L', 'LeftArm', 'skin', (0.36, 0, 1.36), (0.34, 0.08, 0.08)),
    ('arm.R', 'RightArm', 'skin', (-0.36, 0, 1.36), (0.34, 0.08, 0.08)),
]
mesh = bpy.data.meshes.new('Puppet')
bm = bmesh.new()
uv = bm.loops.layers.uv.new('uv')
made = {}
for name, bone, colour, middle, size in PARTS:
    before = len(bm.verts)
    got = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(middle) @ Matrix.Diagonal((*size, 1)))
    faces = {f for v in got['verts'] for f in v.link_faces}
    for face in faces:
        for loop in face.loops:
            loop[uv].uv = WHERE[colour]
    made[name] = (bone, range(before, len(bm.verts)), Vector(middle), Vector(size))
bm.to_mesh(mesh)
bm.free()
puppet = bpy.data.objects.new('Puppet', mesh)
bpy.context.scene.collection.objects.link(puppet)
mesh.materials.append(material)

for name, (bone, verts, _, _) in made.items():
    group = puppet.vertex_groups.get(bone) or puppet.vertex_groups.new(name=bone)
    group.add(list(verts), 1.0, 'REPLACE')

# the shapes: the eyes shut flat, the mouth opened downward
puppet.shape_key_add(name='Basis')
blink = puppet.shape_key_add(name='Blink')
for eye in ('eye.L', 'eye.R'):
    _, verts, middle, _ = made[eye]
    for i in verts:
        blink.data[i].co.z = middle.z
opened = puppet.shape_key_add(name='MouthOpen')
_, verts, middle, size = made['mouth']
top = middle.z + size.z / 2
for i in verts:
    opened.data[i].co.z = top - (top - opened.data[i].co.z) * 5

# the skeleton
armature = bpy.data.armatures.new('Armature')
rig = bpy.data.objects.new('Armature', armature)
bpy.context.scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
BONES = [
    ('Hips', None, (0, 0, 0.85), (0, 0, 0.95)),
    ('Spine', 'Hips', (0, 0, 0.95), (0, 0, 1.15)),
    ('Chest', 'Spine', (0, 0, 1.15), (0, 0, 1.4)),
    ('Neck', 'Chest', (0, 0, 1.4), (0, 0, 1.5)),
    ('Head', 'Neck', (0, 0, 1.5), (0, 0, 1.8)),
    ('LeftArm', 'Chest', (0.19, 0, 1.36), (0.36, 0, 1.36)),
    ('LeftForeArm', 'LeftArm', (0.36, 0, 1.36), (0.53, 0, 1.36)),
    ('RightArm', 'Chest', (-0.19, 0, 1.36), (-0.36, 0, 1.36)),
    ('RightForeArm', 'RightArm', (-0.36, 0, 1.36), (-0.53, 0, 1.36)),
]
for name, parent, head, tail in BONES:
    bone = armature.edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    if parent:
        bone.parent = armature.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
puppet.parent = rig
puppet.modifiers.new('Armature', 'ARMATURE').object = rig

common = dict(add_leaf_bones=False, bake_anim=False, mesh_smooth_type='OFF')
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'puppet.fbx'), path_mode='COPY', embed_textures=True, **common)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'puppet-loose.fbx'), path_mode='AUTO', embed_textures=False, **common)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'puppet.glb'), export_format='GLB', export_animations=False)
print('puppet done')
